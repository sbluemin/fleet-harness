import { randomUUID } from "node:crypto";
import type { McpCatalogReader } from "@fleet-console/agent-runtime/mcp";
import type { SessionBusinessCall, SessionHostEvent, SessionSnapshot } from "@fleet-console/protocol/session-host";
import type { SessionHostClient } from "./client.js";
import type { HostedSessionLaunch, SessionCheckpoint } from "./contracts.js";

/** Console-local bindings. Live execution and admission sequence belong to the host. */
export class HostedExecution {
  private readonly sessions = new Map<string, SessionSnapshot>();
  private readonly aliases = new Map<string, string>();
  private actual(key: string): string { return this.aliases.get(key) ?? key; }
  private logical(key: string): string { const index = key.lastIndexOf(".run."); return index < 0 ? key : key.slice(0, index); }
  describe(key: string): Promise<HostedSessionLaunch> { return this.client.describe(this.actual(key)); }
  private readonly ports = new Map<string, (call: SessionBusinessCall) => unknown | Promise<unknown>>();
  private readonly commandTails = new Map<string, Promise<unknown>>();
  private readonly checkpointTails = new Map<string, Promise<void>>();
  private readonly observers = new Set<AbortController>();
  private readonly failedSessions = new Set<string>();
  /** A failed reattachment retires only this session, never its healthy peers or Console startup. */
  failSession(key: string, error: unknown): void {
    this.failedSessions.add(key);
    this.releaseBindings(key);
    this.failure("session_reattach_failed", error);
    void this.command(key, "close").catch((cause) => this.failure("session_reattach_close_failed", cause));
  }
  private readonly readerFlights = new Set<Promise<void>>();
  private detached = false;
  private updating = false;
  private readonly admissionWaiters = new Set<() => void>();
  get isUpdating(): boolean { return this.updating; }
  setUpdating(value: boolean): void { this.updating = value; if (!value) { for (const ready of this.admissionWaiters) ready(); this.admissionWaiters.clear(); } }
  async waitForAdmission(): Promise<void> {
    if (this.updating && !this.detached) await new Promise<void>((resolve) => this.admissionWaiters.add(resolve));
    if (this.detached) throw new Error("session_observer_detached");
  }
  private hookHandler?: (sessionKey: string, data: unknown, at: number) => Promise<unknown>;
  setHookHandler(handler: (sessionKey: string, data: unknown, at: number) => Promise<unknown>): void {
    this.hookHandler = handler;
    this.bind("execution:agent-policy", (call) => handler(call.sessionKey, call.body, Date.now()));
  }
  private readonly flushers = new Set<() => Promise<void>>();
  beforeUpdate(flush: () => Promise<void>): () => void { this.flushers.add(flush); return () => this.flushers.delete(flush); }
  async flush(): Promise<void> {
    await Promise.all([...this.readerFlights]);
    await Promise.all([...this.commandTails.values()]);
    for (const flush of this.flushers) await flush();
  }
  private constructor(readonly client: SessionHostClient, private readonly onFailure: (kind: string, error: unknown) => void, readonly environment: NodeJS.ProcessEnv, readonly catalog?: { owns(url: string): boolean; read(url: string, request: Parameters<McpCatalogReader>[0]): Promise<unknown> }) {}

  static async attach(client: SessionHostClient, onFailure: (kind: string, error: unknown) => void, environment: NodeJS.ProcessEnv = process.env, catalog?: { owns(url: string): boolean; read(url: string, request: Parameters<McpCatalogReader>[0]): Promise<unknown> }): Promise<HostedExecution> {
    const execution = new HostedExecution(client, onFailure, environment, catalog);
    for (const snapshot of (await client.listSessions()).sessions) {
      execution.sessions.set(snapshot.sessionKey, snapshot);
      const key = execution.logical(snapshot.sessionKey);
      const prior = execution.get(key);
      if (snapshot.state === "live" && prior?.state === "live" && prior.sessionKey !== snapshot.sessionKey) throw new Error("session_live_identity_ambiguous");
      if (!execution.aliases.has(key) || snapshot.state === "live") execution.aliases.set(key, snapshot.sessionKey);
    }
    return execution;
  }
  get isDetached(): boolean { return this.detached; }
  inventory(): readonly SessionSnapshot[] { return [...this.aliases].map(([key]) => ({ ...this.get(key)!, sessionKey: key })); }
  get(key: string): SessionSnapshot | undefined {
    const snapshot = this.sessions.get(this.actual(key));
    return snapshot && this.failedSessions.has(key) ? { ...snapshot, state: "lost" } : snapshot;
  }
  bind(port: string, handler: (call: SessionBusinessCall) => unknown | Promise<unknown>): () => void {
    if (this.ports.has(port)) throw new Error("session_business_port_conflict");
    this.ports.set(port, handler);
    return () => { if (this.ports.get(port) === handler) this.ports.delete(port); };
  }
  releaseBindings(key: string): void { for (const port of this.ports.keys()) if (port.startsWith(`${key}:`)) this.ports.delete(port); }
  async ready(): Promise<void> {
    await this.client.bindBusiness((call) => {
      const handler = this.ports.get(call.port);
      if (!handler || !this.sessions.has(call.sessionKey)) throw new Error("session_business_binding_unavailable");
      return handler({ ...call, sessionKey: this.logical(call.sessionKey) });
    });
  }
  async open(launch: HostedSessionLaunch): Promise<SessionSnapshot> {
    if (this.failedSessions.has(launch.sessionKey)) throw new Error("session_reattach_failed");
    const previous = this.get(launch.sessionKey);
    if (previous?.state === "live") {
      if (previous.kind !== launch.kind) throw new Error("session_kind_conflict");
      return previous;
    }
    if (previous?.state === "starting") throw new Error("session_open_in_progress");
    const logical = launch.sessionKey;
    const actual = `${logical}.run.${randomUUID()}`;
    launch = { ...launch, sessionKey: actual };
    this.aliases.set(logical, actual);
    // Business requests may arrive before open returns; reserve the scope first.
    const opening: SessionSnapshot = { sessionKey: actual, kind: launch.kind, generation: launch.generation.id, startedAt: Date.now(), seq: 0, state: "starting", runtime: {}, checkpoint: null, launchFingerprint: launch.launchFingerprint ?? null, lastCommandSequence: 0, commands: [] };
    this.sessions.set(launch.sessionKey, opening);
    try { const snapshot = await this.client.open(launch); this.sessions.set(launch.sessionKey, snapshot); return snapshot; }
    catch (error) { this.sessions.delete(launch.sessionKey); this.aliases.delete(logical); throw error; }
  }
  async refresh(key: string): Promise<SessionSnapshot> {
    const replay = await this.client.readEvents(this.actual(key), this.get(key)?.seq ?? 0);
    this.sessions.set(this.actual(key), replay.snapshot);
    return replay.snapshot;
  }
  command<T = unknown>(key: string, kind: string, body?: unknown, commandId: string = randomUUID()): Promise<T> {
    const previous = this.commandTails.get(key) ?? Promise.resolve();
    const admission = previous.then(async () => {
      if (this.detached) throw new Error("session_observer_detached");
      const snapshot = await this.refresh(key);
      return this.client.command({ sessionKey: this.actual(key), commandId, sequence: snapshot.lastCommandSequence + 1, kind, body });
    });
    this.commandTails.set(key, admission.catch(() => undefined));
    const work = admission.then(async (accepted) => {
      let record = accepted;
      while (record.state === "accepted") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (this.detached) throw new Error("session_observer_detached");
        const current = await this.client.commandStatus(this.actual(key), commandId);
        // Unknown is never permission to send again.
        if (!current) throw new Error("session_command_unknown");
        record = current;
      }
      if (record.state === "failed") throw new Error(record.error ?? "session_command_failed");
      await this.refresh(key);
      if (kind === "close") { this.releaseBindings(key); this.failedSessions.delete(key); }
      return record.value as T;
    });
    return work;
  }
  checkpoint(key: string, state: Omit<SessionCheckpoint, "version">): Promise<void> {
    const work = (this.checkpointTails.get(key) ?? Promise.resolve()).then(async () => {
      const current = await this.refresh(key);
      const previous = current.checkpoint as SessionCheckpoint | null;
      if (state.lastConsumedSeq < (previous?.lastConsumedSeq ?? 0)) throw new Error("session_checkpoint_stale_capture");
      const checkpoint = { ...state, version: (previous?.version ?? 0) + 1 };
      if (!await this.client.checkpoint(this.actual(key), checkpoint)) throw new Error("session_checkpoint_conflict");
      this.sessions.set(this.actual(key), { ...current, checkpoint });
    });
    this.checkpointTails.set(key, work);
    return work;
  }
  async *events(key: string, afterSeq: number, onGap?: (snapshot: SessionSnapshot) => void, signal?: AbortSignal): AsyncGenerator<SessionHostEvent> {
    const controller = new AbortController(); this.observers.add(controller);
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    let cursor = afterSeq;
    try {
      while (!controller.signal.aborted && !this.detached) {
        const replay = await this.client.readEvents(this.actual(key), cursor);
        this.sessions.set(this.actual(key), replay.snapshot);
        if (replay.gap) {
          if (!onGap) throw new Error("session_replay_gap");
          onGap(replay.snapshot); cursor = replay.snapshot.seq;
        } else for (const event of replay.events) {
          if (controller.signal.aborted || this.detached) return;
          await this.waitForAdmission();
          let finish!: () => void;
          const reading = new Promise<void>((resolve) => { finish = resolve; }); this.readerFlights.add(reading);
          try {
            if (event.kind === "hook" && (event.data as { path?: string })?.path !== "/agent-call") {
              try { await this.hookHandler?.(key, event.data, event.at); }
              catch (error) { this.failure("session_observation_hook_failed", error); }
            }
            yield event; cursor = event.seq;
          } finally { this.readerFlights.delete(reading); finish(); }
        }
        if (replay.snapshot.state === "ended" || replay.snapshot.state === "lost") return;
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 50); controller.signal.addEventListener("abort", done, { once: true });
        });
      }
    } finally { signal?.removeEventListener("abort", abort); this.observers.delete(controller); }
  }
  failure(kind: string, error: unknown): void { if (!this.detached) this.onFailure(kind, error); }
  /** Detach only. The lifecycle owner, not each feature, chooses preserve or terminate. */
  detach(): void {
    this.detached = true;
    for (const ready of this.admissionWaiters) ready(); this.admissionWaiters.clear();
    for (const controller of this.observers) controller.abort();
    this.observers.clear(); this.ports.clear();
  }
}
