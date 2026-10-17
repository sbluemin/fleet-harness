import { useEffect, useState } from "react";
import type { HostSelection, HostTransport, HostView, HostSurfaceState } from "@fleet-console/sdk/host-context";
import { refreshRemoteHosts, useRemoteHosts, type RemoteHost } from "../../../../features/remote-access/client/remote-hosts.js";
import { resolveTheaterInboxLanding } from "../../../../features/workspace/client/theater-contributions.js";
import { openTheaterInbox } from "../../../../features/workspace/client/theater-inbox/store.js";
import { getConversationSurface, subscribeConversationSurface } from "../../../../features/workspace/client/conversation/conversation-surface-store.js";
import { getConversationSubject, subscribeConversationSubject } from "../../../../features/workspace/client/conversation/conversation-slots.js";
import { createHostWorkspace, type HostRuntimePort, type HostWorkspace } from "./host-workspace.js";
import { createRemoteHostRuntime, type RemoteHostRuntime } from "./remote-host-runtime.js";
import { createRemoteHostDependencies, createRemoteHostTransport, type HostBrowserNetwork } from "./remote-host-transport.js";
import { focusOperation, getState, subscribe } from "./store.js";
import { getViewedTheaterId, subscribeViewedTheater } from "./viewed-theater.js";
import type { PluginRegistry } from "./plugin-registry.js";
import { resolveOperationActivity } from "../../../../features/execution/client/operation-activity.js";

export interface HostWorkspaceBinding {
  readonly workspace: HostWorkspace;
  readonly getSelectedTransport: () => HostTransport | null;
  readonly surfaceState: (pluginId: string, transport: HostTransport) => HostSurfaceState;
  readonly events: (transport: HostTransport) => import("@fleet-console/sdk/plugin").ClientConsoleEventsCapability;
  readonly readResource: (transport: HostTransport, path: string, signal?: AbortSignal) => Promise<Response>;
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
  const backgroundAbort = new AbortController();
  let background = Promise.resolve();
  const serialNetwork: HostBrowserNetwork = { ...network, background: (work, signal) => {
    const queued = background.then(async () => { if (!signal.aborted && !backgroundAbort.signal.aborted) await work(); });
    background = queued.catch(() => undefined);
    return queued;
  } };
  const remotes = new Map<string, { descriptor: RemoteHost; runtime: RemoteHostRuntime }>();
  const surfaceStates = new Map<string, Map<string, { values: Map<string, unknown>; listeners: Set<() => void> }>>();
  let selectedTransport: { generation: number; epoch: number; value: HostTransport } | null = null;

  const offState = subscribe(() => {
    localView = readLocalView();
    syncLocal();
    for (const listener of localListeners) listener();
  });
  function syncLocal(): void {
    if (disposed || applyingLocal || workspace.getSnapshot().selection.hostKey !== "local") return;
    const theaterId = getViewedTheaterId();
    const surface = getConversationSurface();
    // focus는 동기 store 변경이고 subject는 렌더 뒤 투영이다. 아직 남은 이전 subject가 새 focus를 되돌리지 않는다.
    const operationId = surface ? null : getState().activeOperationId ?? getConversationSubject()?.id;
    const target: HostSelection = operationId && theaterId
      ? { hostKey: "local", theaterId, role: "commander", operationId }
      : { hostKey: "local", theaterId, role: "commodore", operationId: null };
    const visible = workspace.getSnapshot();
    if (lastObservedLocal && sameSelection(target, lastObservedLocal) && !(visible.foreground === null && visible.phase === "ready")) return;
    lastObservedLocal = target;
    if (!sameSelection(target, visible.selection) || visible.foreground === null) {
      applyingLocal = true;
      try {
        workspace.syncLocalSelection(target);
        appliedLocalGeneration = workspace.getSnapshot().selectionGeneration;
      } finally { applyingLocal = false; }
    }
  }
  const offViewed = subscribeViewedTheater(syncLocal);
  const offSubject = subscribeConversationSubject(syncLocal);
  const offSurface = subscribeConversationSurface(syncLocal);
  const offWorkspace = workspace.subscribe(() => {
    const snapshot = workspace.getSnapshot();
    for (const [key, remote] of remotes) remote.runtime.setVisible(key === snapshot.selection.hostKey);
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
      for (const [key] of remotes) if (!keys.has(key)) { workspace.remove(key); remotes.delete(key); surfaceStates.delete(key); }
      for (const descriptor of hosts) {
        const old = remotes.get(descriptor.id);
        if (old && old.descriptor.origin === descriptor.origin && old.descriptor.fingerprint === descriptor.fingerprint && old.descriptor.label === descriptor.label) continue;
        if (old) { workspace.remove(descriptor.id); surfaceStates.delete(descriptor.id); }
        const runtime = createRemoteHostRuntime(createRemoteHostDependencies(descriptor.id, descriptor.label, serialNetwork));
        remotes.set(descriptor.id, { descriptor, runtime });
        workspace.add(runtime);
        // 배경 목록은 observe만 요청한다. 원격 입력이나 제어 획득은 일어나지 않는다.
        void serialNetwork.background!(async () => { await runtime.observe(backgroundAbort.signal); }, backgroundAbort.signal).catch(() => undefined);
      }
    },
    surfaceState: (pluginId, transport) => {
      const key = transport.scope.hostKey;
      let host = surfaceStates.get(key);
      if (!host) { host = new Map(); surfaceStates.set(key, host); }
      let store = host.get(pluginId);
      if (!store) { store = { values: new Map(), listeners: new Set() }; host.set(pluginId, store); }
      const held = store;
      return {
        read: <T,>(name: string, fallback: T): T => held.values.has(name) ? held.values.get(name) as T : fallback,
        write: (name, value) => {
          transport.scope.signal.throwIfAborted();
          held.values.set(name, value);
          for (const listener of held.listeners) listener();
        },
        subscribe: (listener) => { held.listeners.add(listener); return () => { held.listeners.delete(listener); }; },
      };
    },
    events: (transport) => {
      const runtime = remotes.get(transport.scope.hostKey)?.runtime;
      const hold = (off: () => void) => {
        const release = () => { off(); transport.scope.signal.removeEventListener("abort", release); };
        if (transport.scope.signal.aborted) release();
        else transport.scope.signal.addEventListener("abort", release, { once: true });
        return release;
      };
      return {
        subscribe: (channel, receive) => hold(runtime?.subscribeChannel(channel, (payload) => { if (!transport.scope.signal.aborted) receive(payload); }) ?? (() => undefined)),
        onReconnect: (receive) => hold(runtime?.onReconnect(() => { if (!transport.scope.signal.aborted) receive(); }) ?? (() => undefined)),
      };
    },
    readResource: async (transport, path, signal) => {
      const combined = signal ? AbortSignal.any([transport.scope.signal, signal]) : transport.scope.signal;
      const response = await network.fetch(transport.resourceUrl(path), { signal: combined, redirect: "error" });
      combined.throwIfAborted();
      return response;
    },
    getSelectedTransport: () => {
      const current = workspace.getSnapshot();
      if (current.foreground === null || current.selection.hostKey === "local") return null;
      const runtime = remotes.get(current.selection.hostKey)?.runtime.getTransport();
      if (!runtime || runtime.scope.signal.aborted) return null;
      if (selectedTransport?.generation === current.selectionGeneration && selectedTransport.epoch === runtime.scope.epoch && !selectedTransport.value.scope.signal.aborted) return selectedTransport.value;
      const scope = Object.freeze({ hostKey: current.selection.hostKey, epoch: runtime.scope.epoch, instanceId: runtime.scope.instanceId, signal: AbortSignal.any([workspace.getSelectionSignal(), runtime.scope.signal]) });
      const value = createRemoteHostTransport(scope, network);
      selectedTransport = { generation: current.selectionGeneration, epoch: scope.epoch, value };
      return value;
    },
    dispose: () => {
      disposed = true;
      backgroundAbort.abort();
      offState(); offViewed(); offSubject(); offSurface(); offWorkspace();
      workspace.dispose();
      remotes.clear();
      surfaceStates.clear();
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
    operations: state.operations.map((operation) => ({ id: operation.id, theaterId: operation.theaterId, title: operation.title, type: operation.type, activity: resolveOperationActivity(operation, state.operationRuntime), ...(operation.parentOperationId ? { parentOperationId: operation.parentOperationId } : {}) })),
  });
}

function sameSelection(left: HostSelection, right: HostSelection): boolean {
  return left.hostKey === right.hostKey && left.theaterId === right.theaterId && left.role === right.role && left.operationId === right.operationId;
}
