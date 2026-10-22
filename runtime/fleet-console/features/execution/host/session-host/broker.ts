import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import type { ChildProcess } from "node:child_process";
import { createOwnedProcessRegistry, isPidAlive, observeConsoleLockFile, startConsoleReaper, type ConsoleReaperLink, type ProcessContainmentPort } from "@fleet-console/lifecycle";
import { SessionRpcPeer, privateSessionDirectory, publishSessionHost, removeOwnSessionManifest, sessionHostPaths, withSessionGenerationLock, activateSessionGeneration, retireSessionGeneration, collectSessionGenerations, sessionNonce, sessionProof, sessionChannelKeys, verifySessionProof, validSessionNonce, type SessionAuthChallenge, type SessionHostPlatform } from "@fleet-console/lifecycle/session-host";
import { OWNED_GROUP_TERM_GRACE_MS, CONSOLE_STOP_DEADLINE_MS } from "@fleet-console/protocol/lifecycle";
import { assertSessionKey, SESSION_HOST_POLL_MS, SESSION_RPC_TIMEOUT_MS, SESSION_HOST_WIRE, SESSION_RUNNER_WIRE, SESSION_BUSINESS_MAX, SESSION_COMMAND_MAX, SESSION_HOST_START_MS, SESSION_KEEPER_LOSS_MS, SESSION_OWNER_LOSS_MS, SESSION_REPLAY_MAX_BYTES, SESSION_UPDATE_MAX_MS, type SessionBusinessCall, type SessionCommand, type SessionCommandRecord, type SessionGeneration, type SessionHostEvent, type SessionHostManifest, type SessionHostSnapshot, type SessionOwner, type SessionReplay, type SessionSnapshot, type SessionUpdateRef } from "@fleet-console/protocol/session-host";
import type { HostedSessionLaunch, SessionCheckpoint } from "./contracts.js";

interface LiveSession {
  launch: HostedSessionLaunch;
  snapshot: SessionSnapshot;
  events: SessionHostEvent[];
  bytes: number;
  commands: Map<string, { key: string; record: SessionCommandRecord }>;
  lastCommandSequence: number;
}
interface Runner {
  child: ChildProcess | null;
  capability: string;
  peer: SessionRpcPeer | null;
  ready: Promise<SessionRpcPeer>;
  exited: Promise<void>;
  closing: boolean;
  resolve(peer: SessionRpcPeer): void;
  reject(error: Error): void;
}
interface Business {
  call: SessionBusinessCall;
  dispatched: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  deferred?: import("@fleet-console/protocol/session-host").SessionDeferredBusiness;
}
export interface SessionBrokerOptions {
  readonly dataDir: string;
  readonly generation: SessionGeneration;
  readonly containment?: ProcessContainmentPort;
  readonly platform?: SessionHostPlatform;
  readonly onFailure?: (kind: string, error: unknown) => void;
}
const equal = (a: unknown, b: string) => typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** One slot's ownership policy. Actual feature execution remains in versioned runners. */
export async function runSessionBroker(options: SessionBrokerOptions): Promise<void> {
  if (process.platform === "win32") {
    if (!options.platform || !options.containment) throw new Error("session_windows_platform_required");
    options.platform.assertIndependent();
  }
  const paths = sessionHostPaths(options.dataDir);
  privateSessionDirectory(paths.dir);
  if (process.platform !== "win32") privateSessionDirectory(paths.sockets);
  let manifest: SessionHostManifest;
  let reaper: ConsoleReaperLink | null = null;
  const registry = createOwnedProcessRegistry({ ...(options.containment ? { containment: options.containment } : {}), onRegistered: (g) => reaper?.registered(g), onLeaderExited: (g) => reaper?.leaderExited(g), onRemoved: (g) => reaper?.removed(g) });
  const sessions = new Map<string, LiveSession>();
  const runners = new Map<string, Runner>();
  const peers = new Set<SessionRpcPeer>();
  const business = new Map<string, Business>();
  let owner: { peer: SessionRpcPeer; identity: SessionOwner; ready: boolean } | null = null;
  let epoch = 0;
  let currentGeneration = options.generation.id;
  const retiredGenerations = new Set<string>();
  const diagnostic = (kind: string, generation: string | null, reason: string) => {
    try { fs.appendFileSync(path.join(paths.dir, "failures.jsonl"), JSON.stringify({ at: Date.now(), kind, generation, reason }) + "\n", { mode: 0o600 }); } catch { /* GC 진단 실패도 실행을 막지 않는다. */ }
  };
  const collect = () => collectSessionGenerations({ dataDir: options.dataDir, hostId: manifest.hostId, keep: new Set([options.generation.id, currentGeneration, ...[...runners].filter(([, r]) => r.child && r.child.exitCode === null && r.child.signalCode === null).map(([id]) => id)]), retired: retiredGenerations, diagnostic, owns: options.platform?.owns });
  function retire(id: string): void {
    try { withSessionGenerationLock(options.dataDir, () => retireSessionGeneration(options.dataDir, id, manifest.hostId)); retiredGenerations.add(id); }
    catch (error) { diagnostic("session_generation_gc_deferred", id, error instanceof Error ? error.message : "retirement_failed"); }
  }
  let stopping: Promise<void> | null = null;
  let ownerLostAt = performance.now();
  let update: { id: string; capability: string; committed: boolean; started: number; heartbeat: number; keeper: SessionRpcPeer | null } | null = null;
  const sessionSnapshot = (s: LiveSession): SessionSnapshot => ({ ...s.snapshot, runtime: { ...s.snapshot.runtime, pendingBusiness: [...business.values()].filter((b) => b.call.sessionKey === s.snapshot.sessionKey).map((b) => ({ ...b.call, deferred: b.deferred ?? null, dispatched: b.dispatched })) } });
  const hostSnapshot = (): SessionHostSnapshot => ({ hostId: manifest.hostId, slotKey: manifest.slotKey, epoch, state: stopping ? "stopping" : update?.committed ? "updating" : "attached", sessions: [...sessions.values()].map(sessionSnapshot) });
  const publish = (session: LiveSession, kind: string, data: unknown): void => {
    const event: SessionHostEvent = { sessionKey: session.snapshot.sessionKey, seq: session.snapshot.seq + 1, at: Date.now(), kind, data };
    session.snapshot = { ...session.snapshot, seq: event.seq };
    session.events.push(event); session.bytes += Buffer.byteLength(JSON.stringify(event));
    while (session.bytes > SESSION_REPLAY_MAX_BYTES && session.events.length > 1) session.bytes -= Buffer.byteLength(JSON.stringify(session.events.shift()!));
  };
  function requireOwner(peer: SessionRpcPeer, requestedEpoch: unknown): void {
    if (stopping || owner?.peer !== peer || requestedEpoch !== epoch) throw new Error("stale_session_owner");
  }
  function flushBusiness(): void {
    if (!owner?.ready || update || stopping) return;
    for (const pending of business.values()) {
      if (pending.dispatched || pending.deferred) continue;
      pending.dispatched = true;
      void owner.peer.call("business", pending.call).then((value) => {
        const deferred = value as import("@fleet-console/protocol/session-host").SessionDeferredBusiness | null;
        if (deferred?.$sessionHostDeferred === true) {
          if (!deferred.turnId || !Number.isSafeInteger(deferred.permissionEpoch) || (deferred.lifetime === "turn" ? deferred.expiresAt !== null : deferred.lifetime !== "deadline" || !Number.isFinite(deferred.expiresAt) || deferred.expiresAt <= Date.now())) throw new Error("session_permission_lifetime_invalid");
          pending.dispatched = false; pending.deferred = deferred;
          clearTimeout(pending.timer); pending.timer = undefined;
          if (deferred.lifetime === "deadline") {
            pending.timer = setTimeout(() => { business.delete(pending.call.requestId); pending.reject(new Error("session_permission_expired")); }, deferred.expiresAt - Date.now()); pending.timer.unref();
          }
        } else { clearTimeout(pending.timer); business.delete(pending.call.requestId); pending.resolve(value); }
      }).catch((error: Error) => { clearTimeout(pending.timer); business.delete(pending.call.requestId); pending.reject(error); });
    }
  }
  function businessCall(call: SessionBusinessCall): Promise<unknown> {
    if (stopping || business.size >= SESSION_BUSINESS_MAX || !sessions.has(call.sessionKey)) return Promise.reject(new Error("session_business_unavailable"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { business.delete(call.requestId); reject(new Error("session_business_expired")); }, SESSION_RPC_TIMEOUT_MS);
      timer.unref();
      business.set(call.requestId, { call, dispatched: false, resolve, reject, timer });
      flushBusiness();
    });
  }
  function validOwner(identity: SessionOwner): boolean {
    const lock = observeConsoleLockFile(paths.lockFile);
    return lock.kind === "owner" && !lock.untrusted && lock.alive && lock.instance.pid === identity.pid && lock.instance.payload.startedAt === identity.startedAt && equal(identity.token, lock.instance.payload.token ?? "");
  }
  async function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      clearInterval(watchdog);
      update = null;
      for (const pending of business.values()) { clearTimeout(pending.timer); pending.reject(new Error("session_host_stopping")); }
      business.clear();
      const deadline = setTimeout(() => { registry.killAll(); process.exit(1); }, CONSOLE_STOP_DEADLINE_MS); deadline.unref();
      await Promise.allSettled([...runners.values()].map(async (r) => {
        if (!r.child || r.child.exitCode !== null || r.child.signalCode !== null) return;
        const exited = new Promise<void>((resolve) => r.child!.once("exit", () => resolve()));
        if (r.peer) await r.peer.call("shutdown", undefined, CONSOLE_STOP_DEADLINE_MS - 1_000).catch(() => {});
        await exited;
      }));
      if (process.platform === "win32") {
        registry.killAll();
        while (registry.groups().length > 0) await new Promise((resolve) => setTimeout(resolve, SESSION_HOST_POLL_MS));
        diagnostic("session_host_jobs_drained", null, "remainingJobs=0");
      } else await reaper?.drain();
      for (const id of new Set([options.generation.id, currentGeneration, ...runners.keys()])) retire(id);
      collect();
      for (const peer of peers) peer.close();
      server.close();
      removeOwnSessionManifest(options.dataDir, manifest.hostId);
      // Child/reaper containment completes before natural exit; the final deadline remains armed.
    })();
    return stopping;
  }
  async function runnerFor(generation: SessionGeneration): Promise<SessionRpcPeer> {
    let runner = runners.get(generation.id);
    if (runner?.closing) { await runner.exited; runner = undefined; }
    if (runner) return runner.ready;
    // Never execute a controller-supplied arbitrary path outside this slot's completed generation.
    if (!/^[a-f0-9]{64}$/.test(generation.id)) throw new Error("untrusted_session_generation");
    const expected = fs.realpathSync(path.join(paths.dir, "generations", generation.id));
    if (fs.lstatSync(generation.root).isSymbolicLink() || fs.realpathSync(generation.root) !== expected || fs.readFileSync(path.join(expected, ".complete"), "utf8") !== generation.id || generation.node !== path.join(expected, process.platform === "win32" ? "node.exe" : "node") || generation.runner !== path.join(expected, "dist/session-runner.mjs") || generation.reaper !== path.join(expected, "dist/console-reaper.mjs") || generation.hook !== path.join(expected, "dist/session-hook.mjs")) throw new Error("untrusted_session_generation");
    let resolve!: Runner["resolve"]; let reject!: Runner["reject"];
    const ready = new Promise<SessionRpcPeer>((yes, no) => { resolve = yes; reject = no; });
    let finishExit!: () => void;
    const exited = new Promise<void>((done) => { finishExit = done; });
    const record: Runner = { child: null, peer: null, capability: randomUUID() + randomUUID(), ready, exited, closing: false, resolve, reject };
    runners.set(generation.id, record);
    const timer = setTimeout(() => { if (record.child) registry.killGroup(record.child, "SIGKILL"); reject(new Error("session_runner_start_timeout")); }, SESSION_HOST_START_MS); timer.unref();
    void ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    record.child = withSessionGenerationLock(options.dataDir, () => {
      activateSessionGeneration(options.dataDir, generation.id);
      return registry.spawn({ command: generation.node, args: [generation.runner], env: process.env, detached: true });
    });
    if (process.platform === "win32" && !registry.groups().some((g) => g.pgid === record.child?.pid)) {
      record.child.stdin?.destroy(); record.child.kill("SIGKILL"); reject(new Error("session_runner_containment_failed")); return ready;
    }
    // The runner waits for this stdin payload before it can create agent/PTY/reaper children.
    record.child.stdin?.on("error", () => reject(new Error("session_runner_boot_pipe_failed")));
    record.child.stdin?.end(JSON.stringify({ socket: manifest.socket, runnerCapability: record.capability, generation, hostId: manifest.hostId }));
    let stderr = "";
    record.child.stdout?.resume(); record.child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4_096); });
    record.child.once("error", reject);
    record.child.once("exit", (code, signal) => {
      if (!stopping && (code !== 0 || signal)) {
        try { fs.appendFileSync(paths.dir + "/failures.jsonl", JSON.stringify({ at: Date.now(), kind: "session_runner_exit", generation: generation.id, code, signal, stderr: stderr.slice(-2_048) }) + "\n", { mode: 0o600 }); } catch { /* Diagnostics cannot change containment. */ }
      }
      reject(new Error("session_runner_exited")); record.peer?.close();
      for (const s of sessions.values()) if (s.snapshot.generation === generation.id && s.snapshot.state !== "ended") { s.snapshot = { ...s.snapshot, state: "lost" }; publish(s, "lost", null); }
      retire(generation.id);
      if (runners.get(generation.id) === record) runners.delete(generation.id);
      finishExit();
      collect();
    });
    return ready;
  }
  const server = createServer((socket) => {
    const peer = new SessionRpcPeer(socket); peers.add(peer);
    let role: "console" | "control" | "keeper" | "runner" | null = null;
    let generationId: string | null = null;
    let auth: { challenge: SessionAuthChallenge; serverNonce: string; secret: string; at: number; ownerToken?: string } | null = null;
    peer.onClose(() => { peers.delete(peer); if (owner?.peer === peer) { owner = null; ownerLostAt = performance.now(); } });
    peer.bind(async (method, raw) => {
      const body = (raw ?? {}) as Record<string, unknown>;
      if (method === "auth-challenge") {
        const challenge = body as unknown as SessionAuthChallenge; const identity = challenge.identity;
        if (role || !identity || identity.wire !== SESSION_HOST_WIRE || identity.hostId !== manifest.hostId || !validSessionNonce(challenge.clientNonce) || Buffer.byteLength(JSON.stringify(identity)) > 8192) throw new Error("session_host_auth_failed");
        let secret = manifest.capability; let ownerToken: string | undefined;
        if (identity.role === "runner") { const runner = runners.get(String(identity.generation)); if (!runner) throw new Error("session_host_auth_failed"); secret = runner.capability; }
        else if (identity.role === "keeper") { if (!update || identity.updateId !== update.id) throw new Error("session_host_auth_failed"); secret = update.capability; }
        else if (identity.role === "console") {
          const requestOwner = identity.owner as Pick<SessionOwner, "pid" | "startedAt">; const lock = observeConsoleLockFile(paths.lockFile);
          if (!requestOwner || lock.kind !== "owner" || lock.untrusted || !lock.alive || lock.instance.pid !== requestOwner.pid || lock.instance.payload.startedAt !== requestOwner.startedAt || !lock.instance.payload.token) throw new Error("session_owner_auth_failed");
          ownerToken = lock.instance.payload.token;
        } else if (identity.role !== "control") throw new Error("session_host_auth_failed");
        auth = { challenge, serverNonce: sessionNonce(), secret, at: performance.now(), ownerToken };
        return { serverNonce: auth.serverNonce, proof: sessionProof(secret, "server", [challenge, auth.serverNonce]) };
      }
      if (method === "auth-finish") {
        const response = (raw ?? {}) as Record<string, unknown>;
        const handshake = auth; auth = null;
        if (!handshake || role || performance.now() - handshake.at > SESSION_HOST_START_MS) throw new Error("session_host_auth_failed");
        const context = [handshake.challenge, handshake.serverNonce];
        if (!verifySessionProof(response.proof, handshake.secret, "client", context) || (handshake.ownerToken && !verifySessionProof(response.ownerProof, handshake.ownerToken, "owner", context))) throw new Error("session_host_auth_failed");
        const accepted = (value: unknown) => {
          const keys = sessionChannelKeys(handshake.secret, context); peer.secure(keys.server, keys.client);
          return { value, proof: sessionProof(handshake.secret, "accepted", context) };
        };
        const authIdentity = handshake.challenge.identity;
        const body = authIdentity as Record<string, unknown>;
        if (body.role === "runner") {
          const generation = String(body.generation);
          const runner = runners.get(generation);
          if (!runner || body.runnerWire !== SESSION_RUNNER_WIRE || runner.peer) throw new Error("session_runner_auth_failed");
          role = "runner"; generationId = generation; runner.peer = peer; runner.resolve(peer);
          return accepted({ epoch });
        }
        if (body.role === "keeper") {
          if (!update || body.updateId !== update.id) throw new Error("session_keeper_auth_failed");
          role = "keeper"; update.keeper = peer; update.heartbeat = performance.now(); return accepted({ epoch });
        }
        if (body.role === "control") { role = "control"; return accepted({ epoch }); }
        const ownerIdentity = body.owner as Pick<SessionOwner, "pid" | "startedAt">;
        const identity: SessionOwner = { ...ownerIdentity, token: handshake.ownerToken ?? "" };
        if (body.role !== "console" || !identity || !validOwner(identity)) throw new Error("session_owner_auth_failed");
        if (owner && owner.peer !== peer && validOwner(owner.identity)) throw new Error("session_owner_still_attached");
        if (!owner && epoch > 0 && !update?.committed) throw new Error("session_owner_not_in_update");
        const nextGeneration = String(body.generation);
        withSessionGenerationLock(options.dataDir, () => activateSessionGeneration(options.dataDir, nextGeneration));
        const previousGeneration = currentGeneration; currentGeneration = nextGeneration;
        role = "console"; owner = { peer, identity, ready: false }; epoch += 1; ownerLostAt = performance.now(); update = null;
        if (previousGeneration !== currentGeneration && !runners.has(previousGeneration)) retire(previousGeneration);
        setImmediate(collect); return accepted(hostSnapshot());
      }
      if (!role) throw new Error("session_host_auth_required");
      if (method === "terminate-all" && (role === "console" || role === "control")) { setImmediate(() => { void stop(); }); return true; }
      if (method === "heartbeat" && role === "keeper") { if (!update || update.keeper !== peer) throw new Error("session_keeper_expired"); update.heartbeat = performance.now(); return true; }
      if (method === "snapshot" && (role === "console" || role === "control")) return hostSnapshot();
      if (role === "runner") {
        const session = sessions.get(String(body.sessionKey));
        if (!session || session.snapshot.generation !== generationId) throw new Error("session_runner_scope");
        if (method === "event") {
          const kind = String(body.kind);
          if (kind === "runtime") session.snapshot = { ...session.snapshot, runtime: { ...session.snapshot.runtime, ...body.data as Record<string, unknown> } };
          else if (kind === "ended") {
            session.snapshot = { ...session.snapshot, state: "ended" };
            const runner = runners.get(generationId!);
            if (runner && !runner.closing && [...sessions.values()].every((s) => s.snapshot.generation !== generationId || s.snapshot.state === "ended" || s.snapshot.state === "lost")) {
              runner.closing = true;
              void peer.call("shutdown").catch(() => {});
            }
          }
          else if (kind === "pty-modes") session.snapshot = { ...session.snapshot, runtime: { ...session.snapshot.runtime, modes: body.data } };
          else if (kind === "pty-data") session.snapshot = { ...session.snapshot, runtime: { ...session.snapshot.runtime, scrollback: (String(session.snapshot.runtime.scrollback ?? "") + String(body.data)).slice(-SESSION_REPLAY_MAX_BYTES / 2) } };
          publish(session, kind, body.data); return true;
        }
        if (method === "business") return businessCall(body as unknown as SessionBusinessCall);
        if (method === "cancel-business") {
          const pending = business.get(String(body.requestId));
          if (pending?.call.sessionKey === session.snapshot.sessionKey) { clearTimeout(pending.timer); business.delete(pending.call.requestId); pending.reject(new Error("session_request_cancelled")); }
          return true;
        }
        throw new Error("session_runner_method_denied");
      }
      requireOwner(peer, body.epoch);
      if (method === "backend-ready") { owner!.ready = true; flushBusiness(); return true; }
      if (method === "answer-business" || method === "revoke-business") {
        const pending = business.get(String(body.requestId));
        if (!pending || !pending.deferred || pending.deferred.permissionEpoch !== body.permissionEpoch || (pending.deferred.lifetime === "deadline" && pending.deferred.expiresAt <= Date.now())) throw new Error("session_permission_stale");
        clearTimeout(pending.timer); business.delete(pending.call.requestId);
        if (method === "revoke-business") pending.reject(new Error("session_permission_revoked")); else pending.resolve(body.value);
        return true;
      }
      if (method === "open") {
        if (update) throw new Error("session_update_quiesced");
        const launch = body.launch as HostedSessionLaunch;
        assertSessionKey(launch.sessionKey);
        if (sessions.has(launch.sessionKey)) throw new Error("session_already_exists");
        const fingerprint = launch.launchFingerprint == null ? null : JSON.parse(JSON.stringify(launch.launchFingerprint));
        if (fingerprint && Buffer.byteLength(JSON.stringify(fingerprint)) > 4_096) throw new Error("session_fingerprint_limit");
        const s: LiveSession = { launch: JSON.parse(JSON.stringify(launch)) as HostedSessionLaunch, snapshot: { sessionKey: launch.sessionKey, kind: launch.kind, generation: launch.generation.id, startedAt: Date.now(), state: "starting", seq: 0, runtime: {}, checkpoint: null, lastCommandSequence: 0, commands: [], launchFingerprint: fingerprint }, events: [], bytes: 0, commands: new Map(), lastCommandSequence: 0 };
        sessions.set(launch.sessionKey, s);
        try { const runner = await runnerFor(launch.generation); const runtime = await runner.call<Record<string, unknown>>("open", launch); s.snapshot = { ...s.snapshot, state: "live", runtime: { ...s.snapshot.runtime, ...runtime, runnerPid: runners.get(launch.generation.id)?.child?.pid } }; publish(s, "opened", null); return s.snapshot; }
        catch (error) { s.snapshot = { ...s.snapshot, state: "lost" }; publish(s, "lost", null); throw error; }
      }
      if (method === "prepare-update") {
        options.platform?.assertIndependent();
        if (update) throw new Error("session_update_busy");
        if ([...business.values()].some((p) => p.dispatched)) throw new Error("session_business_not_drained");
        const now = performance.now();
        update = { id: String(body.updateId), capability: randomUUID() + randomUUID(), committed: false, started: now, heartbeat: now, keeper: null };
        const { capability: _hostCapability, ...keeperHost } = manifest;
        const ref: SessionUpdateRef = { updateId: update.id, keeperCapability: update.capability, host: keeperHost, expiresAt: Date.now() + SESSION_UPDATE_MAX_MS };
        return ref;
      }
      if (method === "commit-update") { if (!update || update.id !== body.updateId || !update.keeper || update.keeper.isClosed) throw new Error("session_update_keeper_missing"); update.committed = true; return true; }
      if (method === "cancel-update") { if (update?.id !== body.updateId) throw new Error("session_update_mismatch"); update = null; flushBusiness(); return true; }
      const session = sessions.get(String(body.sessionKey));
      if (!session) throw new Error("session_not_found");
      if (method === "events") { const after = Number(body.afterSeq); const replay: SessionReplay = { snapshot: sessionSnapshot(session), events: session.events.filter((e) => e.seq > after), gap: after < (session.events[0]?.seq ?? 1) - 1 }; return replay; }
      if (method === "describe") return session.launch;
      if (method === "command-status") return session.commands.get(String(body.commandId))?.record ?? null;
      if (method === "checkpoint") {
        const next = body.checkpoint as SessionCheckpoint;
        const previous = session.snapshot.checkpoint as SessionCheckpoint | null;
        if (next.version !== (previous?.version ?? 0) + 1 || next.lastConsumedSeq < (previous?.lastConsumedSeq ?? 0) || next.lastConsumedSeq > session.snapshot.seq || (next.activeCommandId !== null && !session.commands.has(next.activeCommandId)) || Buffer.byteLength(JSON.stringify(next)) > SESSION_REPLAY_MAX_BYTES) throw new Error("session_checkpoint_conflict");
        session.snapshot = { ...session.snapshot, checkpoint: next }; return true;
      }
      if (method !== "command" || update) throw new Error("session_command_unavailable");
      const command = body as unknown as SessionCommand & { sequence: number };
      assertSessionKey(command.commandId);
      const key = JSON.stringify([command.kind, command.body]);
      const old = session.commands.get(command.commandId);
      if (old) { if (old.key !== key) throw new Error("session_command_id_conflict"); return old.record; }
      if (!Number.isSafeInteger(command.sequence) || command.sequence !== session.lastCommandSequence + 1) throw new Error("session_command_sequence_conflict");
      if (session.commands.size >= SESSION_COMMAND_MAX) {
        const inputs = (session.snapshot.runtime.pendingInputs ?? []) as { commandId: string }[];
        const checkpoint = session.snapshot.checkpoint as SessionCheckpoint | null;
        const protectedIds = new Set([...inputs.map((i) => i.commandId), checkpoint?.activeCommandId]);
        const retired = [...session.commands].find(([id, c]) => c.record.state !== "accepted" && !protectedIds.has(id));
        if (!retired) throw new Error("session_command_capacity");
        session.commands.delete(retired[0]);
      }
      session.lastCommandSequence = command.sequence;
      const record: SessionCommandRecord = { commandId: command.commandId, sequence: command.sequence, state: "accepted" };
      session.commands.set(command.commandId, { key, record });
      session.snapshot = { ...session.snapshot, commands: [...session.commands.values()].map((c) => c.record), lastCommandSequence: command.sequence };
      const runner = runners.get(session.snapshot.generation)?.peer;
      if (!runner) throw new Error("session_runner_lost");
      void runner.call("command", command).then((value) => {
        session.commands.set(command.commandId, { key, record: { commandId: command.commandId, sequence: command.sequence, state: "completed", value } });
      }, (error: Error) => {
        session.commands.set(command.commandId, { key, record: { commandId: command.commandId, sequence: command.sequence, state: "failed", error: error.message } });
      }).finally(() => { session.snapshot = { ...session.snapshot, commands: [...session.commands.values()].map((c) => c.record) }; publish(session, "command", session.commands.get(command.commandId)!.record); });
      return record;
    });
  });
  const socketName = process.platform === "win32" ? `${paths.socket}-${randomUUID()}` : paths.socket;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketName, resolve); });
  if (process.platform !== "win32") fs.chmodSync(socketName, 0o600);
  try { manifest = publishSessionHost(options.dataDir, socketName); } catch (error) { server.close(); throw error; }
  if (process.platform !== "win32" && paths.relocatedSocketNamespace) {
    try { fs.appendFileSync(path.join(paths.dir, "failures.jsonl"), JSON.stringify({ at: Date.now(), kind: "session_socket_namespace_relocated", reason: "temporary_path_length", transport: "unix" }) + "\n", { mode: 0o600 }); } catch { /* Diagnostic failure cannot widen the transport. */ }
  }
  collect();
  if (process.platform !== "win32") reaper = startConsoleReaper({ script: options.generation.reaper, env: process.env, instance: { consolePid: process.pid, lockFile: paths.manifest, lockStartedAt: manifest.startedAt }, groups: () => registry.groups(), onDegraded: (e) => options.onFailure?.("session_host_reaper_degraded", e) });
  const watchdog = setInterval(() => {
    const now = performance.now();
    if (stopping) return;
    if (update && (now - update.started > SESSION_UPDATE_MAX_MS || (update.committed && (update.keeper?.isClosed || now - update.heartbeat > SESSION_KEEPER_LOSS_MS)))) { void stop(); return; }
    if (owner && (!isPidAlive(owner.identity.pid) || !validOwner(owner.identity))) { owner.peer.close(); owner = null; ownerLostAt = now; }
    if (!owner && !update?.committed && now - ownerLostAt >= SESSION_OWNER_LOSS_MS) void stop();
  }, SESSION_HOST_POLL_MS);
  process.on("SIGTERM", () => { void stop(); }); process.on("SIGINT", () => { void stop(); });
  process.on("uncaughtException", () => process.exit(1));
}
