import type { HostKey, HostSelection, HostView, HostWorkspacePort, HostWorkspaceSnapshot } from "@fleet-console/sdk/host-context";

/** 연결의 실제 전송·snapshot 수명은 host runtime이 소유한다. workspace는 전경 선택만 조율한다. */
export interface HostRuntimePort {
  readonly getSnapshot: () => HostView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly observe: (signal: AbortSignal) => Promise<void>;
  readonly pair?: (signal: AbortSignal) => Promise<void>;
  readonly activate: (signal: AbortSignal) => Promise<void>;
  readonly resolveObjective?: (theaterId: string, objectiveId: string, signal: AbortSignal) => Promise<void>;
  readonly dispose: () => void;
}

export interface HostWorkspace extends HostWorkspacePort {
  readonly add: (runtime: HostRuntimePort) => void;
  readonly syncLocalSelection: (selection: HostSelection) => void;
  readonly getSelectionSignal: () => AbortSignal;
  readonly remove: (hostKey: HostKey) => void;
  readonly dispose: () => void;
}

const LOCAL_SELECTION: HostSelection = Object.freeze({ hostKey: "local", theaterId: null, role: "commodore", operationId: null });

/** 전역 모듈 상태를 만들지 않는다. 독립 workspace의 같은 Theater/Operation id는 서로 만나지 않는다. */
export function createHostWorkspace(local: HostRuntimePort): HostWorkspace {
  if (local.getSnapshot().hostKey !== "local") throw new Error("local_host_required");
  const runtimes = new Map<HostKey, { runtime: HostRuntimePort; off: () => void }>();
  const listeners = new Set<() => void>();
  let selection: HostSelection = LOCAL_SELECTION;
  let lastLocal: HostSelection = LOCAL_SELECTION;
  let foreground: HostSelection | null = null;
  let foregroundEpoch: number | null = null;
  let foregroundInstanceId: string | undefined;
  let activated = false;
  let localAuthorityEpoch = local.getSnapshot().epoch;
  let generation = 0;
  let selectionAbort = new AbortController();
  let error: string | null = null;
  let selecting = false;
  let disposed = false;
  let snapshot: HostWorkspaceSnapshot;

  function publish(): void {
    const hosts = [...runtimes.values()].map(({ runtime }) => runtime.getSnapshot());
    const selected = hosts.find((host) => host.hostKey === selection.hostKey);
    if (!selected || selected.epoch !== foregroundEpoch || selected.instanceId !== foregroundInstanceId || selected.connection !== "ready" || selected.phase !== "ready" || !containsSelection(selected, selection)) {
      foreground = null;
      activated = false;
    }
    if (!selecting && error === null && foreground === null && selected?.connection === "ready" && selected.phase === "ready" && containsSelection(selected, selection)) {
      foreground = selection;
      foregroundEpoch = selected.epoch;
      foregroundInstanceId = selected.instanceId;
    }
    // 로컬 준비 상태의 일시 손실은 권한 획득을 요구하지 않는다. 원격 획득/회수와 다른 수명이다.
    if (!selecting && selection.hostKey === "local" && selected?.epoch === localAuthorityEpoch) {
      activated = foreground !== null && selected.mode === "controller" && selected.access === "full";
    }
    snapshot = Object.freeze({
      hosts: Object.freeze(hosts), selection, foreground, selectionGeneration: generation,
      phase: error !== null ? "error" : selecting ? "loading" : selected?.phase ?? "idle",
      canWrite: activated && foreground !== null && selected?.mode === "controller" && selected.access === "full" && selected.connection === "ready" && selected.phase === "ready",
      error: error ?? selected?.error ?? null,
    });
    for (const listener of listeners) listener();
  }

  function assertSelection(next: HostSelection): HostRuntimePort {
    if (disposed) throw new Error("host_workspace_disposed");
    const runtime = runtimes.get(next.hostKey)?.runtime;
    if (!runtime) throw new Error("remote_host_unknown");
    if (next.role === "commodore" ? next.operationId !== null : !next.operationId || !next.theaterId) throw new Error("invalid_host_selection");
    return runtime;
  }

  function begin(next: HostSelection): { runtime: HostRuntimePort; signal: AbortSignal; current: () => boolean } {
    const runtime = assertSelection(next);
    selectionAbort.abort();
    selectionAbort = new AbortController();
    const signal = selectionAbort.signal;
    const ownGeneration = ++generation;
    selection = Object.freeze({ ...next });
    if (next.hostKey === "local") { lastLocal = selection; localAuthorityEpoch = runtime.getSnapshot().epoch; }
    foreground = null;
    foregroundEpoch = null;
    activated = false;
    error = null;
    selecting = true;
    publish();
    return { runtime, signal, current: () => !disposed && !signal.aborted && generation === ownGeneration };
  }

  function containsSelection(view: HostView, target: HostSelection): boolean {
    if (target.theaterId === null) return target.role === "commodore";
    if (!view.theaters.some((theater) => theater.id === target.theaterId)) return false;
    return target.role === "commodore" || view.operations.some((operation) => operation.id === target.operationId && operation.theaterId === target.theaterId && (target.hostKey === "local" || (operation.type === "agent" && !operation.parentOperationId)))
      || (view.objectives ?? []).some((objective) => objective.id === target.operationId && objective.theaterId === target.theaterId);
  }

  function select(next: HostSelection): void {
    const pending = begin(next);
    void pending.runtime.observe(pending.signal).then(() => {
      if (!pending.current()) return;
      const view = pending.runtime.getSnapshot();
      if (!containsSelection(view, next)) error = "host_selection_missing";
      else { foreground = selection; foregroundEpoch = view.epoch; foregroundInstanceId = view.instanceId; activated = next.hostKey === "local" && view.mode === "controller"; }
      selecting = false;
      publish();
    }, (cause: unknown) => {
      if (!pending.current()) return;
      error = errorCode(cause);
      selecting = false;
      publish();
    });
  }

  async function activateConversation(next: HostSelection, objective = false): Promise<void> {
    if (next.theaterId === null) throw new Error("conversation_required");
    const pending = begin(next);
    const requestedInstance = pending.runtime.getSnapshot().instanceId;
    try {
      await pending.runtime.observe(pending.signal);
      if (!pending.current()) return;
      if (objective) {
        if (next.role !== "commander" || !pending.runtime.resolveObjective) throw new Error("objective_selection_unavailable");
        await pending.runtime.resolveObjective(next.theaterId, next.operationId, pending.signal);
        if (!pending.current()) return;
      }
      const observed = pending.runtime.getSnapshot();
      if (requestedInstance !== undefined && observed.instanceId !== requestedInstance) throw new Error("stale_instance");
      if (!containsSelection(observed, next)) throw new Error("host_selection_missing");
      if (observed.access === "monitoring") {
        foreground = selection;
        foregroundEpoch = observed.epoch;
        foregroundInstanceId = observed.instanceId;
        selecting = false;
        publish();
        return;
      }
      if (observed.access !== "full") throw new Error("observer_only");
      await pending.runtime.activate(pending.signal);
      if (!pending.current()) return;
      if (objective && next.role === "commander") {
        await pending.runtime.resolveObjective!(next.theaterId, next.operationId, pending.signal);
        if (!pending.current()) return;
      }
      const active = pending.runtime.getSnapshot();
      if (active.instanceId !== observed.instanceId) throw new Error("stale_instance");
      if (active.mode !== "controller" || active.access !== "full" || active.connection !== "ready" || active.phase !== "ready") throw new Error("not_controller");
      if (!containsSelection(active, next)) throw new Error("host_selection_missing");
      foreground = selection;
      foregroundEpoch = active.epoch;
      foregroundInstanceId = active.instanceId;
      activated = true;
      selecting = false;
      publish();
    } catch (cause) {
      if (!pending.current()) return;
      error = errorCode(cause);
      selecting = false;
      publish();
      throw cause;
    }
  }

  function add(runtime: HostRuntimePort): void {
    if (disposed) throw new Error("host_workspace_disposed");
    const key = runtime.getSnapshot().hostKey;
    if (runtimes.has(key)) throw new Error("duplicate_host_runtime");
    const off = runtime.subscribe(publish);
    runtimes.set(key, { runtime, off });
    publish();
  }

  add(local);
  return {
    getSnapshot: () => snapshot,
    getSelectionSignal: () => selectionAbort.signal,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select,
    pair: async (hostKey, signal) => {
      signal.throwIfAborted();
      if (disposed) throw new Error("host_workspace_disposed");
      const runtime = runtimes.get(hostKey)?.runtime;
      if (!runtime) throw new Error("remote_host_unknown");
      if (hostKey === "local" || !runtime.pair) throw new Error("host_unsupported");
      const current = () => {
        signal.throwIfAborted();
        if (disposed || runtimes.get(hostKey)?.runtime !== runtime) throw new DOMException("host_pair_cancelled", "AbortError");
      };
      // 연결 대상만 고정한다. begin/select/activate를 거치지 않아 현재 대화를 보존한다.
      // 같은 id로 교체된 대상에는 이전 성공뿐 아니라 이전 실패도 전달하지 않는다.
      try { await runtime.pair(signal); }
      catch (cause) { current(); throw cause; }
      current();
    },
    activateConversation,
    activateObjective: (next) => activateConversation(next, true),
    returnLocal: () => select(lastLocal),
    syncLocalSelection: (next) => {
      if (selection.hostKey !== "local" || next.hostKey !== "local") return;
      const pending = begin(next);
      const view = pending.runtime.getSnapshot();
      if (containsSelection(view, next)) { foreground = selection; foregroundEpoch = view.epoch; foregroundInstanceId = view.instanceId; activated = view.mode === "controller"; }
      selecting = false;
      publish();
    },
    add,
    remove: (key) => {
      if (key === "local") throw new Error("local_host_required");
      const held = runtimes.get(key);
      if (!held) return;
      held.off();
      held.runtime.dispose();
      runtimes.delete(key);
      if (selection.hostKey === key) select(lastLocal);
      else publish();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      selectionAbort.abort();
      for (const { runtime, off } of runtimes.values()) { off(); runtime.dispose(); }
      runtimes.clear();
      listeners.clear();
    },
  };
}

function errorCode(cause: unknown): string {
  return cause instanceof Error ? cause.message : "host_request_failed";
}
