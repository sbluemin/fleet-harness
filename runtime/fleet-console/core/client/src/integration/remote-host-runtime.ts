import type { HostEventSource, HostScope, HostTransport, HostView, HostTheaterSummary, HostOperationSummary, HostObjectiveSummary } from "@fleet-console/sdk/host-context";
import { readHostJson } from "@fleet-console/sdk/host-context/browser";
import type { HostRuntimePort } from "./host-workspace.js";
import { sessionRuntime } from "@fleet-console/sdk/operations/activity";
import { fetchSessions } from "../../../../features/execution/client/agent/api.js";
import { interpretAgentSessionFrame } from "../../../../features/execution/client/agent/sse.js";
import type { SessionInfo } from "../../../../features/execution/client/agent/types.js";

export type HostPresenceView = Pick<HostView, "hostKey" | "epoch" | "mode" | "access" | "connection"> & { readonly instanceId: string };

/** wire 해석은 제품 전송 어댑터가 맡는다. runtime은 검증된 존재/전송만 받아 상태를 소유한다. */
export interface RemoteHostRuntimeDependencies {
  readonly hostKey: string;
  readonly label: string;
  readonly readPresence: (signal: AbortSignal) => Promise<HostPresenceView>;
  readonly pair?: (epoch: number, instanceId: string, signal: AbortSignal) => Promise<void>;
  readonly changePresence: (intent: "observe" | "activate", epoch: number, instanceId: string, signal: AbortSignal) => Promise<HostPresenceView>;
  readonly watchPresence: (receive: (presence: HostPresenceView) => void | Promise<void>, failed: (cause: Error) => void) => () => void;
  readonly createTransport: (scope: HostScope) => HostTransport;
}

export interface RemoteHostRuntime extends HostRuntimePort {
  readonly pair: (signal: AbortSignal) => Promise<void>;
  readonly getTransport: () => HostTransport | null;
  readonly setVisible: (visible: boolean) => void;
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
  let agentSource: HostEventSource | null = null;
  const sessions = new Map<string, SessionInfo>();
  let sessionRevision = 0;
  let objectiveRevision = 0;
  const withActivity = (operations: readonly HostOperationSummary[]) => operations.map((operation): HostOperationSummary => {
    const session = sessions.get(operation.id);
    const runtime = session ? sessionRuntime(session) : null;
    return { ...operation, activity: runtime ? runtime.lifecycle === "dormant" ? "ended" : runtime.activity : "unknown" };
  });
  let state: HostView = Object.freeze({ hostKey: deps.hostKey, label: deps.label, epoch: 0, mode: "off", access: null, connection: "closed", trust: "unknown", phase: "idle", error: null, theaters: [], operations: [], objectives: [] });
  const listeners = new Set<() => void>();
  const channels = new Map<string, Set<(payload: unknown) => void>>();
  const attached = new Set<string>();
  const reconnectListeners = new Set<() => void>();
  let snapshotFlight: Promise<void> | null = null;
  let observeFlight: Promise<void> | null = null;
  let pairFlight: Promise<void> | null = null;
  let revision = 0;
  let refreshPending = false;
  let opened = false;
  let visible = false;
  let retiredInstanceId: string | null = null;
  let discoveryAbort = new AbortController();
  let discoveryVersion = 0;
  let discoveryRequest = 0;
  let acceptedRequest = 0;
  let offPresence: (() => void) | null = null;

  function restartDiscovery(): void {
    discoveryAbort.abort();
    discoveryAbort = new AbortController();
    discoveryVersion += 1;
    offPresence?.();
    const version = discoveryVersion;
    offPresence = deps.watchPresence(async () => {
      // 비고정 watch 사건은 wake-up 힌트다. 오래된 연결의 payload로 수명을 바꾸지 않는다.
      if (version !== discoveryVersion || lifetime.signal.aborted || pairFlight) return;
      await discover(async (signal) => deps.readPresence(signal));
      if ((!visible || state.phase !== "ready") && state.connection === "ready" && state.mode !== "off") await refresh();
    }, (cause) => {
      if (version !== discoveryVersion || lifetime.signal.aborted || pairFlight) return;
      fail(cause);
    });
  }

  async function discover(read: (signal: AbortSignal) => Promise<HostPresenceView>, outer = lifetime.signal): Promise<void> {
    const version = discoveryVersion;
    const request = ++discoveryRequest;
    const signal = AbortSignal.any([outer, lifetime.signal, discoveryAbort.signal, AbortSignal.timeout(10_000)]);
    let presence: HostPresenceView;
    try { presence = await read(signal); }
    catch (cause) { if (version !== discoveryVersion || request < acceptedRequest) return; acceptedRequest = request; throw cause; }
    outer.throwIfAborted();
    if (version !== discoveryVersion || request < acceptedRequest) return;
    signal.throwIfAborted();
    acceptedRequest = request;
    acceptPresence(presence);
  }

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
    agentSource?.close();
    agentSource = null;
    sessions.clear();
    attached.clear();
    snapshotFlight = null;
    refreshPending = false;
    opened = false;
  }

  function acceptPresence(presence: HostPresenceView): void {
    if (lifetime.signal.aborted || presence.hostKey !== deps.hostKey) return;
    const newLifetime = presence.instanceId !== state.instanceId;
    if ((!newLifetime && presence.epoch < state.epoch) || presence.instanceId === retiredInstanceId) return;
    if (newLifetime) { retiredInstanceId = state.instanceId ?? null; restartDiscovery(); }
    const replaced = newLifetime || presence.epoch !== state.epoch;
    const unavailable = presence.connection !== "ready" || presence.mode === "off";
    if (replaced || unavailable) clearConnection();
    publish({ ...presence, ...(replaced || unavailable ? { theaters: [], operations: [], objectives: [], phase: presence.connection === "blocked" ? "error" : "loading" } : {}), trust: presence.connection === "ready" ? "verified" : state.trust });
    if (!unavailable && transport === null) {
      const scope = Object.freeze({ hostKey: deps.hostKey, epoch: presence.epoch, instanceId: presence.instanceId, signal: scopeAbort.signal });
      transport = deps.createTransport(scope);
    }
  }

  function fail(cause: unknown): void {
    const code = cause instanceof Error ? cause.message : "remote_host_unavailable";
    acceptedRequest = ++discoveryRequest;
    clearConnection();
    publish({ phase: "error", connection: "blocked", error: code, theaters: [], operations: [], objectives: [], ...(code === "remote_host_fingerprint_mismatch" ? { trust: "mismatch" as const } : {}) });
  }

  /**
   * 배경 스냅샷의 실패. 활성화·관찰이 epoch나 수명을 바꾸면 옛 scope의 요청이 stale로 끝난다 — 그것은 호스트 오류가 아니라 "다시 읽어라"는
   * 신호다. fail()은 더 늦은 발견을 모두 버리고 연결을 끊으므로, 같은 명령이 막 받은 새 presence까지 버려 호출자가 transport 없이
   * (host_inactive) 남는다. 대신 presence를 다시 읽어 새 좌표에 붙는다. 다시 읽은 뒤의 실패는 일반 오류로 끝내 반복하지 않는다.
   */
  function refreshFailed(cause: unknown): void {
    const code = cause instanceof Error ? cause.message : "";
    if (code !== "stale_epoch" && code !== "stale_instance") { fail(cause); return; }
    void discover((signal) => deps.readPresence(signal)).then(async () => {
      if (state.connection === "ready" && state.mode !== "off") await refresh();
    }).catch(fail);
  }

  function attachChannel(channel: string): void {
    const current = source;
    if (!current || attached.has(channel)) return;
    attached.add(channel);
    current.addEventListener(channel, (event) => {
      if (source !== current || lifetime.signal.aborted) return;
      let payload: unknown;
      try { payload = JSON.parse((event as MessageEvent<string>).data); } catch { return; }
      for (const receive of channels.get(channel) ?? []) { try { receive(payload); } catch { /* 한 표면의 오류가 다른 host 구독자를 막지 않는다. */ } }
    });
  }

  function openEvents(bound: HostTransport): void {
    if (!visible || source || bound.scope.signal.aborted) return;
    const next = bound.events("/api/v1/operations/events");
    source = next;
    const current = () => source === next && !bound.scope.signal.aborted;
    for (const name of ["operation:changed", "operation:removed", "theater:changed", "theater:removed", "group:changed", "group:removed"]) {
      next.addEventListener(name, () => { if (current()) void refresh().catch(refreshFailed); });
    }
    next.addEventListener("objectives:objective", (event) => {
      if (!current()) return;
      let body: unknown;
      try { body = JSON.parse((event as MessageEvent<string>).data); } catch { return; }
      if (!record(body) || typeof body.objectiveId !== "string" || typeof body.theaterId !== "string") return;
      objectiveRevision += 1;
      const held = state.objectives ?? [];
      if (!held.some((item) => item.id === body.objectiveId && item.theaterId === body.theaterId)) return;
      const updated = body.op === "upsert" ? readObjective(body.objective, body.theaterId, body.objectiveId) : null;
      publish({ objectives: updated ? [updated] : [] });
    });
    for (const name of channels.keys()) attachChannel(name);
    next.addEventListener("control:reclaimed", () => {
      if (!current()) return;
      clearConnection();
      publish({ mode: "off", access: null, connection: "closed", phase: "error", error: "not_controller", theaters: [], operations: [], objectives: [] });
    });
    next.addEventListener("control:changed", () => {
      if (!current()) return;
      // holder DTO만으로 자기 권한을 추정하지 않는다. 쓰기를 먼저 막고 presence의 실제 mode를 다시 읽는다.
      publish({ phase: "loading" });
      void discover((signal) => deps.readPresence(signal)).then(async () => {
        if (state.connection === "ready" && state.mode !== "off") await refresh();
      }).catch((cause: unknown) => { if (current()) fail(cause); });
    });
    const agents = bound.events("/api/v1/agent/events");
    agentSource = agents;
    for (const name of ["session:updated", "session:attention"]) agents.addEventListener(name, (event) => {
      if (agentSource !== agents || bound.scope.signal.aborted) return;
      const frame = interpretAgentSessionFrame({ event: name, data: (event as MessageEvent<string>).data });
      if (!frame) return;
      sessionRevision += 1;
      sessions.set(frame.session.sessionId, frame.kind === "attention" && frame.reason !== "idle_prompt" ? { ...frame.session, attentionPending: true } : frame.session);
      publish({ operations: withActivity(state.operations) });
      for (const receive of channels.get(name) ?? []) { try { receive({ session: frame.session }); } catch { /* 구독자별 실패는 격리한다. */ } }
    });
    agents.onopen = () => { if (agentSource === agents && !bound.scope.signal.aborted) void refresh().catch(refreshFailed); };
    agents.onerror = () => { if (agentSource === agents && !bound.scope.signal.aborted) publish({ operations: state.operations.map((operation) => ({ ...operation, activity: "unknown" })) }); };
    next.onopen = () => {
      if (!current()) return;
      const reconnected = opened;
      opened = true;
      void refresh().then(() => { if (current() && reconnected) for (const receive of reconnectListeners) { try { receive(); } catch { /* 표면 오류를 연결 오류로 바꾸지 않는다. */ } } }).catch(refreshFailed);
    };
    next.onerror = () => {
      if (!current()) return;
      publish({ phase: "loading", connection: "connecting" });
    };
  }

  async function readSnapshot(bound: HostTransport, version: number, outer = lifetime.signal): Promise<void> {
    const sessionVersion = sessionRevision;
    const signal = AbortSignal.any([outer, bound.scope.signal, AbortSignal.timeout(10_000)]);
    // 배경 관찰 한 건이 남은 HTTP 슬롯을 모두 잡지 않도록 snapshot의 세 조회도 직렬화한다.
    const theatersResponse = await bound.request("/api/v1/theaters", { signal });
    const operationsResponse = await bound.request("/api/v1/operations", { signal });
    const sessionSnapshot = await fetchSessions(signal, bound);
    if (!theatersResponse.ok || !operationsResponse.ok) throw new Error(`host_snapshot_http_${!theatersResponse.ok ? theatersResponse.status : operationsResponse.status}`);
    const [theatersBody, operationsBody] = await Promise.all([
      readHostJson<{ theaters?: unknown }>(bound.scope, theatersResponse),
      readHostJson<{ operations?: unknown }>(bound.scope, operationsResponse),
    ]);
    signal.throwIfAborted();
    if (version !== revision || bound !== transport) return;
    if (sessionVersion === sessionRevision) sessions.clear();
    for (const session of sessionSnapshot) if (sessionVersion === sessionRevision || !sessions.has(session.sessionId)) sessions.set(session.sessionId, session);
    const theaters = readTheaters(theatersBody.theaters);
    const operations = withActivity(readOperations(operationsBody.operations));
    publish({ theaters, operations, phase: "ready", connection: "ready", error: null });
    openEvents(bound);
  }

  function refresh(outer = lifetime.signal): Promise<void> {
    if (snapshotFlight) { refreshPending = true; return snapshotFlight; }
    const bound = transport;
    if (!bound) return Promise.reject(new Error("host_inactive"));
    const version = revision;
    const flight = readSnapshot(bound, version, outer).catch((cause: unknown) => {
      if (version !== revision || bound.scope.signal.aborted || bound !== transport) return;
      throw cause;
    }).finally(() => {
      if (snapshotFlight !== flight) return;
      snapshotFlight = null;
      if (refreshPending) { refreshPending = false; void refresh().catch(refreshFailed); }
    });
    snapshotFlight = flight;
    return flight;
  }

  async function observe(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    if (pairFlight) {
      await pairFlight;
      signal.throwIfAborted();
      return;
    }
    if (!observeFlight) {
      const work = (async () => {
        await discover((readSignal) => deps.readPresence(readSignal));
        if (state.mode === "off" || state.connection !== "ready") {
          const { epoch, instanceId } = state;
          if (!instanceId) throw new Error("host_inactive");
          await discover((readSignal) => deps.changePresence("observe", epoch, instanceId, readSignal));
        }
        await refresh();
      })();
      observeFlight = work;
      void work.finally(() => { if (observeFlight === work) observeFlight = null; }).catch(() => undefined);
    }
    try { await observeFlight; } catch (cause) { fail(cause); throw cause; }
    signal.throwIfAborted();
  }

  async function pair(outer: AbortSignal): Promise<void> {
    outer.throwIfAborted();
    lifetime.signal.throwIfAborted();
    if (!pairFlight) {
      const pairHost = deps.pair;
      if (!pairHost) throw new Error("host_unsupported");
      const signal = AbortSignal.any([outer, lifetime.signal, AbortSignal.timeout(30_000)]);
      const work = (async () => {
        // 이미 진행 중인 관찰과 한 번의 handoff 소비가 경합하지 않게 한다.
        if (observeFlight) await observeFlight.catch(() => undefined);
        signal.throwIfAborted();
        await discover((readSignal) => deps.readPresence(readSignal), signal);
        signal.throwIfAborted();
        const { epoch, instanceId } = state;
        if (!instanceId) throw new Error("host_inactive");
        if (state.mode !== "off" && state.connection === "ready") { await refresh(signal); return; }
        const current = () => {
          signal.throwIfAborted();
          if (state.instanceId !== instanceId) throw new Error("stale_instance");
          if (state.epoch !== epoch) throw new Error("stale_epoch");
        };
        await pairHost(epoch, instanceId, signal);
        current();
        // pair는 좌표를 바꾸지 않는다. 재탐색으로 새 수명에 붙지 않고 같은 좌표로 관찰만 연다.
        await discover(async (readSignal) => {
          current();
          const presence = await deps.changePresence("observe", epoch, instanceId, readSignal);
          current();
          if (presence.instanceId !== instanceId) throw new Error("stale_instance");
          if (presence.mode !== "observer") throw new Error("invalid_host_response");
          return presence;
        }, signal);
        signal.throwIfAborted();
        const observed = transport;
        await refresh(signal);
        signal.throwIfAborted();
        if (state.instanceId !== instanceId) throw new Error("stale_instance");
        if (!observed || observed !== transport || observed.scope.signal.aborted) throw new Error("stale_epoch");
      })();
      pairFlight = work;
      void work.finally(() => { if (pairFlight === work) pairFlight = null; }).catch(() => undefined);
    }
    // 동시 클릭은 같은 작업을 기다린다. 오류를 capability 판정이나 자동 재시도로 바꾸지 않는다.
    // 전송이 취소보다 늦게 실패하더라도 폐기된 runtime의 오류를 새 host 카드에 싣지 않는다.
    try { await pairFlight; }
    catch (cause) {
      lifetime.signal.throwIfAborted();
      outer.throwIfAborted();
      throw cause;
    }
    lifetime.signal.throwIfAborted();
    outer.throwIfAborted();
  }

  restartDiscovery();

  return {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    observe,
    pair,
    activate: async (signal) => {
      signal.throwIfAborted();
      const { epoch, instanceId } = state;
      if (!instanceId) throw new Error("host_inactive");
      await discover((readSignal) => deps.changePresence("activate", epoch, instanceId, readSignal), signal);
      signal.throwIfAborted();
      if (state.instanceId !== instanceId) throw new Error("stale_instance");
      await refresh();
      signal.throwIfAborted();
      if (state.instanceId !== instanceId) throw new Error("stale_instance");
    },
    resolveObjective: async (theaterId, objectiveId, outer) => {
      const bound = transport;
      if (!bound || !state.theaters.some((theater) => theater.id === theaterId)) throw new Error("host_selection_missing");
      const signal = AbortSignal.any([outer, bound.scope.signal, AbortSignal.timeout(10_000)]);
      const version = objectiveRevision;
      const response = await bound.request("/plugins/objectives/objective/get", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ objectiveId }), signal,
      });
      const body = await readHostJson<{ objective?: unknown }>(bound.scope, response);
      signal.throwIfAborted();
      if (bound !== transport || version !== objectiveRevision) throw new Error("stale_objective_selection");
      const objective = response.ok ? readObjective(body.objective, theaterId, objectiveId) : null;
      if (!objective) throw new Error("host_selection_missing");
      // 방문한 목표 하나만 보유한다. 모든 Theater를 훑거나 Operation을 합성하지 않는다.
      publish({ objectives: [objective] });
    },
    getTransport: () => transport,
    setVisible: (next) => {
      if (visible === next || lifetime.signal.aborted) return;
      visible = next;
      if (next) { if (transport && state.phase === "ready") openEvents(transport); }
      else { source?.close(); source = null; agentSource?.close(); agentSource = null; attached.clear(); opened = false; }
    },
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
      discoveryAbort.abort();
      offPresence?.();
      offPresence = null;
      listeners.clear();
      channels.clear();
      reconnectListeners.clear();
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readObjective(value: unknown, theaterId: string, objectiveId: string): HostObjectiveSummary | null {
  if (!record(value) || value.id !== objectiveId || value.theaterId !== theaterId || typeof value.title !== "string" || !record(value.commander) || typeof value.commander.started !== "boolean") return null;
  return Object.freeze({ id: objectiveId, theaterId, title: value.title, started: value.commander.started });
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
  return value.flatMap((entry: unknown): HostOperationSummary[] => {
    if (!record(entry) || typeof entry.id !== "string" || typeof entry.theaterId !== "string" || typeof entry.title !== "string" || typeof entry.type !== "string") throw new Error("invalid_host_snapshot");
    const parent = Object.freeze({ id: entry.id, theaterId: entry.theaterId, title: entry.title, type: entry.type, ...(typeof entry.parentOperationId === "string" ? { parentOperationId: entry.parentOperationId } : {}) });
    const children = Array.isArray(entry.childSessions) ? entry.childSessions.flatMap((child: unknown): HostOperationSummary[] => record(child) && typeof child.id === "string"
      ? [Object.freeze({ id: child.id, theaterId: parent.theaterId, title: child.id, type: parent.type, parentOperationId: parent.id })] : []) : [];
    return [parent, ...children];
  });
}
