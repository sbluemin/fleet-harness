import type { HostEventSource, HostScope, HostTransport, HostView, HostTheaterSummary, HostOperationSummary } from "@fleet-console/sdk/host-context";
import { readHostJson } from "@fleet-console/sdk/host-context/browser";
import type { HostRuntimePort } from "./host-workspace.js";

export type HostPresenceView = Pick<HostView, "hostKey" | "epoch" | "mode" | "access" | "connection">;

/** wire 해석은 제품 전송 어댑터가 맡는다. runtime은 검증된 존재/전송만 받아 상태를 소유한다. */
export interface RemoteHostRuntimeDependencies {
  readonly hostKey: string;
  readonly label: string;
  readonly readPresence: (signal: AbortSignal) => Promise<HostPresenceView>;
  readonly changePresence: (intent: "observe" | "activate", epoch: number, signal: AbortSignal) => Promise<HostPresenceView>;
  readonly watchPresence: (receive: (presence: HostPresenceView) => void, failed: (cause: Error) => void) => () => void;
  readonly createTransport: (scope: HostScope) => HostTransport;
}

export interface RemoteHostRuntime extends HostRuntimePort {
  readonly getTransport: () => HostTransport | null;
  readonly subscribeChannel: (channel: string, receive: (payload: unknown) => void) => () => void;
  readonly onReconnect: (listener: () => void) => () => void;
}

/** host별 연결·snapshot·구독·재조회 상태다. 같은 id를 가진 다른 host와 module map을 공유하지 않는다. */
export function createRemoteHostRuntime(deps: RemoteHostRuntimeDependencies): RemoteHostRuntime {
  if (deps.hostKey === "local") throw new Error("remote_host_required");
  const lifetime = new AbortController();
  let scopeAbort = new AbortController();
  let transport: HostTransport | null = null;
  let source: HostEventSource | null = null;
  let state: HostView = Object.freeze({ hostKey: deps.hostKey, label: deps.label, epoch: 0, mode: "off", access: null, connection: "closed", trust: "unknown", phase: "idle", error: null, theaters: [], operations: [] });
  const listeners = new Set<() => void>();
  const channels = new Map<string, Set<(payload: unknown) => void>>();
  const attached = new Set<string>();
  const reconnectListeners = new Set<() => void>();
  let snapshotFlight: Promise<void> | null = null;
  let observeFlight: Promise<void> | null = null;
  let revision = 0;
  let refreshPending = false;
  let opened = false;

  function publish(patch: Partial<HostView>): void {
    if (lifetime.signal.aborted) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  }

  function clearConnection(): void {
    revision += 1;
    scopeAbort.abort();
    scopeAbort = new AbortController();
    transport = null;
    source?.close();
    source = null;
    attached.clear();
    snapshotFlight = null;
    refreshPending = false;
    opened = false;
  }

  function acceptPresence(presence: HostPresenceView): void {
    if (lifetime.signal.aborted || presence.hostKey !== deps.hostKey || presence.epoch < state.epoch) return;
    const replaced = presence.epoch !== state.epoch;
    const unavailable = presence.connection !== "ready" || presence.mode === "off";
    if (replaced || unavailable) clearConnection();
    publish({ ...presence, ...(replaced || unavailable ? { theaters: [], operations: [], phase: presence.connection === "blocked" ? "error" : "loading" } : {}), trust: presence.connection === "ready" ? "verified" : state.trust });
    if (!unavailable && transport === null) {
      const scope = Object.freeze({ hostKey: deps.hostKey, epoch: presence.epoch, signal: scopeAbort.signal });
      transport = deps.createTransport(scope);
    }
  }

  function fail(cause: unknown): void {
    const code = cause instanceof Error ? cause.message : "remote_host_unavailable";
    clearConnection();
    publish({ phase: "error", connection: "blocked", error: code, theaters: [], operations: [], ...(code === "remote_host_fingerprint_mismatch" ? { trust: "mismatch" as const } : {}) });
  }

  function attachChannel(channel: string): void {
    const current = source;
    if (!current || attached.has(channel)) return;
    attached.add(channel);
    current.addEventListener(channel, (event) => {
      if (source !== current || lifetime.signal.aborted) return;
      let payload: unknown;
      try { payload = JSON.parse((event as MessageEvent<string>).data); } catch { return; }
      for (const receive of channels.get(channel) ?? []) receive(payload);
    });
  }

  function openEvents(bound: HostTransport): void {
    if (source || bound.scope.signal.aborted) return;
    const next = bound.events("/api/v1/operations/events");
    source = next;
    const current = () => source === next && !bound.scope.signal.aborted;
    for (const name of ["operation:changed", "operation:removed", "theater:changed", "theater:removed", "group:changed", "group:removed"]) {
      next.addEventListener(name, () => { if (current()) void refresh().catch(fail); });
    }
    for (const name of channels.keys()) attachChannel(name);
    next.onopen = () => {
      if (!current()) return;
      const reconnected = opened;
      opened = true;
      void refresh().then(() => { if (current() && reconnected) for (const receive of reconnectListeners) receive(); }).catch(fail);
    };
    next.onerror = () => {
      if (!current()) return;
      publish({ phase: "loading", connection: "connecting" });
    };
  }

  async function readSnapshot(bound: HostTransport, version: number): Promise<void> {
    const [theatersResponse, operationsResponse] = await Promise.all([
      bound.request("/api/v1/theaters"), bound.request("/api/v1/operations"),
    ]);
    if (!theatersResponse.ok || !operationsResponse.ok) throw new Error(`host_snapshot_http_${!theatersResponse.ok ? theatersResponse.status : operationsResponse.status}`);
    const [theatersBody, operationsBody] = await Promise.all([
      readHostJson<{ theaters?: unknown }>(bound.scope, theatersResponse),
      readHostJson<{ operations?: unknown }>(bound.scope, operationsResponse),
    ]);
    if (version !== revision || bound !== transport) return;
    const theaters = readTheaters(theatersBody.theaters);
    const operations = readOperations(operationsBody.operations);
    publish({ theaters, operations, phase: "ready", connection: "ready", error: null });
    openEvents(bound);
  }

  function refresh(): Promise<void> {
    if (snapshotFlight) { refreshPending = true; return snapshotFlight; }
    const bound = transport;
    if (!bound) return Promise.reject(new Error("host_inactive"));
    const version = revision;
    const flight = readSnapshot(bound, version).catch((cause: unknown) => {
      if (version !== revision || bound.scope.signal.aborted || bound !== transport) return;
      throw cause;
    }).finally(() => {
      if (snapshotFlight !== flight) return;
      snapshotFlight = null;
      if (refreshPending) { refreshPending = false; void refresh().catch(fail); }
    });
    snapshotFlight = flight;
    return flight;
  }

  async function observe(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    if (!observeFlight) {
      const work = (async () => {
        let presence = await deps.readPresence(lifetime.signal);
        acceptPresence(presence);
        if (presence.mode === "off" || presence.connection !== "ready") {
          presence = await deps.changePresence("observe", presence.epoch, lifetime.signal);
          acceptPresence(presence);
        }
        await refresh();
      })();
      observeFlight = work;
      void work.finally(() => { if (observeFlight === work) observeFlight = null; }).catch(() => undefined);
    }
    try { await observeFlight; } catch (cause) { fail(cause); throw cause; }
    signal.throwIfAborted();
  }

  const offPresence = deps.watchPresence((presence) => {
    acceptPresence(presence);
    if (presence.connection === "ready" && presence.mode !== "off") void refresh().catch(fail);
  }, (cause) => { fail(cause); });

  return {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    observe,
    activate: async (signal) => {
      signal.throwIfAborted();
      const presence = await deps.changePresence("activate", state.epoch, signal);
      signal.throwIfAborted();
      acceptPresence(presence);
      await refresh();
      signal.throwIfAborted();
    },
    getTransport: () => transport,
    subscribeChannel: (channel, receive) => {
      let held = channels.get(channel);
      if (!held) { held = new Set(); channels.set(channel, held); }
      held.add(receive);
      attachChannel(channel);
      return () => { held.delete(receive); };
    },
    onReconnect: (listener) => { reconnectListeners.add(listener); return () => { reconnectListeners.delete(listener); }; },
    dispose: () => {
      lifetime.abort();
      clearConnection();
      offPresence();
      listeners.clear();
      channels.clear();
      reconnectListeners.clear();
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readTheaters(value: unknown): readonly HostTheaterSummary[] {
  if (!Array.isArray(value)) throw new Error("invalid_host_snapshot");
  return value.map((entry: unknown) => {
    if (!record(entry) || typeof entry.id !== "string" || typeof entry.label !== "string") throw new Error("invalid_host_snapshot");
    return Object.freeze({ id: entry.id, label: entry.label, ...(typeof entry.alias === "string" ? { alias: entry.alias } : {}) });
  });
}

function readOperations(value: unknown): readonly HostOperationSummary[] {
  if (!Array.isArray(value)) throw new Error("invalid_host_snapshot");
  return value.map((entry: unknown) => {
    if (!record(entry) || typeof entry.id !== "string" || typeof entry.theaterId !== "string" || typeof entry.title !== "string" || typeof entry.type !== "string") throw new Error("invalid_host_snapshot");
    return Object.freeze({ id: entry.id, theaterId: entry.theaterId, title: entry.title, type: entry.type, ...(typeof entry.parentOperationId === "string" ? { parentOperationId: entry.parentOperationId } : {}) });
  });
}
