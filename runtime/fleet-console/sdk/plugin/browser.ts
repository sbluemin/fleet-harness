import * as React from "react";

import { assertOperationNode, ApiError } from "../operations/browser.js";
import type { OperationNode } from "../operations/types.js";
import type { FleetClientPlugin, OperationKindDescriptor, PluginInstallContext, UseOperationsResult } from "./types.js";

export { React };

export function definePlugin(definition: FleetClientPlugin): FleetClientPlugin {
  return definition;
}

export function defineOperationKind(descriptor: OperationKindDescriptor): OperationKindDescriptor {
  return descriptor;
}

export function createClientCapabilities(resync: () => void = () => undefined): PluginInstallContext {
  const disposables = new Set<() => void>();
  return {
    api: {
      fetch: (pluginId, path, init) => fetch(resolvePluginPath(pluginId, path), init).then(assertSafeResponse),
      subscribe: (pluginId, path, onMessage) => {
        const source = new EventSource(resolvePluginPath(pluginId, path));
        source.onmessage = onMessage;
        const cleanup = () => source.close();
        disposables.add(cleanup);
        return () => {
          cleanup();
          disposables.delete(cleanup);
        };
      },
      resync,
    },
    lifecycle: {
      onDispose: (cleanup) => {
        disposables.add(cleanup);
        return () => disposables.delete(cleanup);
      },
    },
    terminal: {
      requestTicket: async (pluginId, path, operationId, signal) => {
        const response = await fetch(resolvePluginPath(pluginId, path), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operationId }),
          signal,
        });
        if (!response.ok) throw new ApiError(response.status, `Terminal ticket request failed: ${response.status}`);
        const payload = await response.json() as { readonly ticket?: unknown; readonly ttlMs?: unknown };
        if (typeof payload.ticket !== "string" || typeof payload.ttlMs !== "number") throw new ApiError(response.status, "Invalid terminal ticket response");
        return { ticket: payload.ticket, ttlMs: payload.ttlMs };
      },
    },
    notifications: {
      emit: () => undefined,
      dismiss: () => undefined,
    },
    operations: {
      createRoot: async (input) => {
        const response = await fetch("/operations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) throw new ApiError(response.status, `Operation create failed: ${response.status}`);
        const payload = await response.json() as { readonly operation?: unknown };
        return assertOperationNode(payload.operation);
      },
      createChild: async (parentId, input) => {
        const parent = await fetchOperation(parentId);
        const response = await fetch("/operations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, parentId, theaterId: parent.theaterId }),
        });
        if (!response.ok) throw new ApiError(response.status, `Operation create failed: ${response.status}`);
        const payload = await response.json() as { readonly operation?: unknown };
        return assertOperationNode(payload.operation);
      },
      rename: async (operationId, title) => {
        const response = await fetch(`/operations/${encodeURIComponent(operationId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        if (!response.ok) throw new ApiError(response.status, `Operation rename failed: ${response.status}`);
        const payload = await response.json() as { readonly operation?: unknown };
        return assertOperationNode(payload.operation);
      },
      remove: async (operationId) => {
        const response = await fetch(`/operations/${encodeURIComponent(operationId)}`, { method: "DELETE" });
        if (!response.ok) throw new ApiError(response.status, `Operation remove failed: ${response.status}`);
      },
    },
    preferences: {
      read: (key, fallback) => readPreference(key, fallback),
      write: (key, value) => writePreference(key, value),
    },
    status: {
      set: () => undefined,
      clear: () => undefined,
    },
  };
}

export function useStoreSnapshot<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useOperationTree(operations: readonly OperationNode[], parentId: string | null = null): readonly OperationNode[] {
  return React.useMemo(() => operations.filter((operation) => operation.parentId === parentId), [operations, parentId]);
}

export function useOperations(): UseOperationsResult {
  const [operations, setOperations] = React.useState<readonly OperationNode[]>([]);
  const refresh = React.useCallback(async () => {
    const response = await fetch("/operations");
    if (!response.ok) throw new ApiError(response.status, `Operations request failed: ${response.status}`);
    const payload = await response.json() as { readonly operations?: readonly unknown[] };
    setOperations(Array.isArray(payload.operations) ? payload.operations.map(assertOperationNode) : []);
  }, []);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  return { operations, refresh };
}

async function assertSafeResponse(response: Response): Promise<Response> {
  if (!response.ok) throw new ApiError(response.status, `Plugin request failed: ${response.status}`);
  return response;
}

async function fetchOperation(operationId: string): Promise<OperationNode> {
  const response = await fetch(`/operations/${encodeURIComponent(operationId)}`);
  if (!response.ok) throw new ApiError(response.status, `Operation request failed: ${response.status}`);
  const payload = await response.json() as { readonly operation?: unknown };
  return assertOperationNode(payload.operation);
}

function resolvePluginPath(pluginId: string, path: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId)) throw new ApiError(400, "Invalid plugin id");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (suffix.includes("..")) throw new ApiError(400, "Invalid plugin path");
  return `/plugins/${pluginId}${suffix}`;
}

function readPreference<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(`fleet-plugin.${key}`);
    return stored === null ? fallback : JSON.parse(stored) as T;
  } catch {
    return fallback;
  }
}

function writePreference<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`fleet-plugin.${key}`, JSON.stringify(value));
  } catch {
    // 환경설정 영속화는 best-effort다.
  }
}
