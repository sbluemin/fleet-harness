import { useEffect, useState } from "react";
import type { HostSelection, HostTransport, HostView } from "@fleet-console/sdk/host-context";
import { refreshRemoteHosts, useRemoteHosts, type RemoteHost } from "../../../../features/remote-access/client/remote-hosts.js";
import { resolveTheaterInboxLanding } from "../../../../features/workspace/client/theater-contributions.js";
import { openTheaterInbox } from "../../../../features/workspace/client/theater-inbox/store.js";
import { getConversationSurface } from "../../../../features/workspace/client/conversation/conversation-surface-store.js";
import { getConversationSubject } from "../../../../features/workspace/client/conversation/conversation-slots.js";
import { createHostWorkspace, type HostRuntimePort, type HostWorkspace } from "./host-workspace.js";
import { createRemoteHostRuntime, type RemoteHostRuntime } from "./remote-host-runtime.js";
import { createRemoteHostDependencies, createRemoteHostTransport, type HostBrowserNetwork } from "./remote-host-transport.js";
import { focusOperation, getState, subscribe } from "./store.js";
import { getViewedTheaterId, subscribeViewedTheater } from "./viewed-theater.js";
import type { PluginRegistry } from "./plugin-registry.js";

export interface HostWorkspaceBinding {
  readonly workspace: HostWorkspace;
  readonly getSelectedTransport: () => HostTransport | null;
  readonly updateHosts: (hosts: readonly RemoteHost[]) => void;
  readonly dispose: () => void;
}

/** 실제 앱의 로컬 상태와 host별 runtime을 잇는 유일한 composition 지점이다. */
export function createAppHostWorkspace(registry: PluginRegistry, network: HostBrowserNetwork): HostWorkspaceBinding {
  let disposed = false;
  let applyingLocal = false;
  let lastObservedLocal: HostSelection | null = null;
  let appliedLocalGeneration = -1;
  const localListeners = new Set<() => void>();
  let localView = readLocalView();
  const local: HostRuntimePort = {
    getSnapshot: () => localView,
    subscribe: (listener) => { localListeners.add(listener); return () => { localListeners.delete(listener); }; },
    observe: async (signal) => { signal.throwIfAborted(); },
    activate: async (signal) => {
      signal.throwIfAborted();
      // 원격 controller 회수는 기존 명시적 ControlCurtain에 남긴다. 탐색으로 회수하지 않는다.
      if (getState().controlHolder !== null) throw new Error("read_only");
    },
    dispose: () => { localListeners.clear(); },
  };
  const workspace = createHostWorkspace(local);
  const remotes = new Map<string, { descriptor: RemoteHost; runtime: RemoteHostRuntime }>();
  let selectedTransport: { generation: number; epoch: number; value: HostTransport } | null = null;

  const offState = subscribe(() => {
    localView = readLocalView();
    for (const listener of localListeners) listener();
  });
  const syncLocal = () => {
    if (applyingLocal || workspace.getSnapshot().selection.hostKey !== "local") return;
    const theaterId = getViewedTheaterId();
    const surface = getConversationSurface();
    const operationId = surface ? null : getConversationSubject()?.id ?? getState().activeOperationId;
    const target: HostSelection = operationId && theaterId
      ? { hostKey: "local", theaterId, role: "commander", operationId }
      : { hostKey: "local", theaterId, role: "commodore", operationId: null };
    const visible = workspace.getSnapshot();
    if (lastObservedLocal && sameSelection(target, lastObservedLocal) && !(visible.foreground === null && visible.phase === "ready")) return;
    lastObservedLocal = target;
    if (!sameSelection(target, workspace.getSnapshot().selection) || workspace.getSnapshot().foreground === null) workspace.syncLocalSelection(target);
  };
  const offViewed = subscribeViewedTheater(syncLocal);
  const offWorkspace = workspace.subscribe(() => {
    const snapshot = workspace.getSnapshot();
    const target = snapshot.foreground;
    if (!target || target.hostKey !== "local" || applyingLocal || appliedLocalGeneration === snapshot.selectionGeneration) return;
    appliedLocalGeneration = snapshot.selectionGeneration;
    applyingLocal = true;
    try {
      if (target.role === "commander") {
        if (getState().activeOperationId !== target.operationId || getConversationSurface() !== null) focusOperation(target.operationId);
      } else if (target.theaterId !== null && (getViewedTheaterId() !== target.theaterId || getConversationSurface() === null)) {
        const landing = resolveTheaterInboxLanding(registry.theaterContributions, target.theaterId);
        if (landing) openTheaterInbox({ theaterId: target.theaterId, ...landing });
      }
      lastObservedLocal = target;
    } finally { applyingLocal = false; }
  });
  syncLocal();

  return {
    workspace,
    updateHosts: (hosts) => {
      if (disposed) return;
      const keys = new Set(hosts.map((host) => host.id));
      for (const [key] of remotes) if (!keys.has(key)) { workspace.remove(key); remotes.delete(key); }
      for (const descriptor of hosts) {
        const old = remotes.get(descriptor.id);
        if (old && old.descriptor.origin === descriptor.origin && old.descriptor.fingerprint === descriptor.fingerprint && old.descriptor.label === descriptor.label) continue;
        if (old) workspace.remove(descriptor.id);
        const runtime = createRemoteHostRuntime(createRemoteHostDependencies(descriptor.id, descriptor.label, network));
        remotes.set(descriptor.id, { descriptor, runtime });
        workspace.add(runtime);
        // 배경 목록은 observe만 요청한다. 원격 입력이나 제어 획득은 일어나지 않는다.
        void runtime.observe(new AbortController().signal).catch(() => undefined);
      }
    },
    getSelectedTransport: () => {
      const current = workspace.getSnapshot();
      if (current.foreground === null || current.selection.hostKey === "local") return null;
      const runtime = remotes.get(current.selection.hostKey)?.runtime.getTransport();
      if (!runtime || runtime.scope.signal.aborted) return null;
      if (selectedTransport?.generation === current.selectionGeneration && selectedTransport.epoch === runtime.scope.epoch) return selectedTransport.value;
      const scope = Object.freeze({ hostKey: current.selection.hostKey, epoch: runtime.scope.epoch, signal: AbortSignal.any([workspace.getSelectionSignal(), runtime.scope.signal]) });
      const value = createRemoteHostTransport(scope, network);
      selectedTransport = { generation: current.selectionGeneration, epoch: scope.epoch, value };
      return value;
    },
    dispose: () => {
      disposed = true;
      offState(); offViewed(); offWorkspace();
      workspace.dispose();
      remotes.clear();
      selectedTransport = null;
    },
  };
}

export function useHostWorkspace(registry: PluginRegistry, enabled: boolean): HostWorkspaceBinding | null {
  const hosts = useRemoteHosts();
  const [binding, setBinding] = useState<HostWorkspaceBinding | null>(null);
  useEffect(() => {
    if (!enabled) { setBinding(null); return; }
    const created = createAppHostWorkspace(registry, { fetch: (...args) => fetch(...args), events: (path) => new EventSource(path), socket: (url) => new WebSocket(url), origin: window.location.origin });
    const abort = new AbortController();
    setBinding(created);
    void refreshRemoteHosts(abort.signal).catch(() => undefined);
    return () => { abort.abort(); created.dispose(); };
  }, [registry, enabled]);
  useEffect(() => { binding?.updateHosts(hosts); }, [binding, hosts]);
  return binding;
}

function readLocalView(): HostView {
  const state = getState();
  return Object.freeze({
    hostKey: "local", label: state.consoleName, epoch: 0,
    connection: state.connection === "live" ? "ready" : state.connection === "offline" ? "closed" : "connecting",
    trust: "verified", access: "full", mode: state.controlHolder === null ? "controller" : "observer",
    phase: state.operationsHydrated && state.connection === "live" ? "ready" : "loading", error: state.theaterError,
    theaters: state.theaters.map(({ id, label, alias }) => ({ id, label, ...(alias ? { alias } : {}) })),
    operations: state.operations.map(({ id, theaterId, title, type, parentOperationId }) => ({ id, theaterId, title, type, ...(parentOperationId ? { parentOperationId } : {}) })),
  });
}

function sameSelection(left: HostSelection, right: HostSelection): boolean {
  return left.hostKey === right.hostKey && left.theaterId === right.theaterId && left.role === right.role && left.operationId === right.operationId;
}
