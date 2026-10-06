import { requestShellOpenAt, requestShellRestartAt } from "../navigation/browser.js";
import * as React from "react";

import { assertOperationNode, ApiError } from "../operations/browser.js";
import type { OperationNode } from "../operations/types.js";
import type { ModelRoster, ModelRosterTarget } from "../models/index.js";
import type {
  ClientApiCapability,
  ClientModelsCapability,
  ClientOperationRuntimeCapability,
  ClientPreferencesCapability,
  ClientSettingsCapability,
  FleetClientPlugin,
  OperationKindDescriptor,
  OperationMenuContext,
  OperationRuntimeHydration,
  OperationRuntimeState,
  PluginInstallContext,
  UseOperationsResult,
} from "./types.js";

export interface BoundPluginApi {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly subscribe: (path: string, onMessage: (event: MessageEvent<string>) => void) => () => void;
}

export interface BoundPluginSettings {
  readonly read: () => Promise<Record<string, unknown> | null>;
  readonly write: (value: Record<string, unknown>) => Promise<void>;
}

export interface BoundOperationRuntime {
  readonly set: (state: OperationRuntimeState) => void;
  readonly clear: () => void;
}

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
    // 기본은 "아직 읽히지 않음"이다 — 실험 기능의 부재는 곧 꺼짐이므로 호스트가 덮어쓰기 전까지
    // 어떤 플러그인도 실험을 켜진 것으로 읽을 수 없다.
    experiments: {
      read: () => null,
      subscribe: () => () => undefined,
      update: async () => false,
      saving: () => false,
      modelOptions: async () => [],
    },
    // 로스터는 호스트 클라이언트 상태다 — 사본은 「아직 읽지 않음」으로 남고 Console이 실제 스토어로 덮는다.
    models: {
      read: () => null,
      load: async () => [],
      subscribe: () => () => undefined,
      refresh: () => undefined,
    },
    // 채팅 렌더러는 호스트 기능이다 — 사본은 아무것도 그리지 않고, Console이 실제 턴 렌더러로 덮는다.
    chat: { Transcript: () => null },
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
    // 콘솔 상태·주소·확대 슬롯은 전부 호스트 클라이언트 상태다 — SDK 사본은 무해한
    // no-op으로 두고, Console이 실제 구현으로 덮는다.
    consoleState: {
      getTheaters: () => [],
      getOperations: () => [],
      getActiveTheaterId: () => null,
      getActiveOperationId: () => null,
      // 스트림이 없는 사본은 끊긴 적도 없다 — offline 으로 두면 플러그인이 영원히 단절로 읽는다.
      getConnection: () => "live",
      // 런타임 축을 보고하는 권위자가 없는 사본은 기다릴 것도 없다 — 호스트 스토어의 기본값과 같다.
      getOperationRuntimeHydration: () => "ready",
      getSelectedOperationId: () => null,
      setActiveTheater: () => undefined,
      subscribe: () => () => undefined,
    },
    navigate: {
      openFile: async () => ({ ok: false, reason: "no_handler" }),
      openWikiEntry: async () => ({ ok: false, reason: "no_handler" }),
    },
    shell: { openAt: requestShellOpenAt, restartAt: requestShellRestartAt },
    navigation: {
      getSearchParam: () => null,
      setSearchParams: () => undefined,
      subscribe: () => () => undefined,
    },
    rail: {
      open: () => undefined,
      close: () => undefined,
      isOpen: () => false,
    },
    consoleEvents: {
      subscribe: () => () => undefined,
      // 스트림이 없는 사본은 다시 붙을 일도 없다.
      onReconnect: () => () => undefined,
    },
    surfaces: {
      open: () => "",
      close: () => undefined,
      closeSurface: () => undefined,
      isOpen: () => false,
    },
    composer: {
      open: () => undefined,
    },
    operations: {
      create: async (input) => {
        const response = await fetch("/api/v1/operations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) throw new ApiError(response.status, `Operation create failed: ${response.status}`);
        const payload = await response.json() as { readonly operation?: unknown };
        return assertOperationNode(payload.operation);
      },
      rename: async (operationId, title) => {
        const response = await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        if (!response.ok) throw new ApiError(response.status, `Operation rename failed: ${response.status}`);
        const payload = await response.json() as { readonly operation?: unknown };
        return assertOperationNode(payload.operation);
      },
      remove: async (operationId) => {
        const response = await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`, { method: "DELETE" });
        if (!response.ok) throw new ApiError(response.status, `Operation remove failed: ${response.status}`);
      },
      focus: () => undefined,
    },
    preferences: {
      read: (key, fallback) => readPreference(key, fallback),
      write: (key, value) => writePreference(key, value),
    },
    settings: {
      read: async (pluginId) => {
        const response = await fetch(resolvePluginSettingsPath(pluginId));
        if (!response.ok) throw new ApiError(response.status, `Plugin settings read failed: ${response.status}`);
        const payload = await response.json() as { readonly value?: unknown };
        const value = payload.value;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
        return null;
      },
      write: async (pluginId, value) => {
        const response = await fetch(resolvePluginSettingsPath(pluginId), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        });
        if (!response.ok) throw new ApiError(response.status, `Plugin settings write failed: ${response.status}`);
      },
    },
    runtime: {
      set: () => undefined,
      clear: () => undefined,
      setHydration: () => undefined,
    },
    statusDetail: {
      set: () => undefined,
      clear: () => undefined,
    },
  };
}

export function useStoreSnapshot<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useOperations(): UseOperationsResult {
  const [operations, setOperations] = React.useState<readonly OperationNode[]>([]);
  const refresh = React.useCallback(async () => {
    const response = await fetch("/api/v1/operations");
    if (!response.ok) throw new ApiError(response.status, `Operations request failed: ${response.status}`);
    const payload = await response.json() as { readonly operations?: readonly unknown[] };
    // 서버 목록에는 최상위 Operation만 있다. 자식은 각 부모의 childSessions에서 파생한다.
    setOperations(Array.isArray(payload.operations) ? payload.operations.map(assertOperationNode) : []);
  }, []);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  return { operations, refresh };
}

export function usePluginApi(api: ClientApiCapability, pluginId: string): BoundPluginApi {
  return React.useMemo(() => ({
    fetch: (path, init) => api.fetch(pluginId, path, init),
    subscribe: (path, onMessage) => api.subscribe(pluginId, path, onMessage),
  }), [api, pluginId]);
}

export function usePluginSettings(settings: ClientSettingsCapability, pluginId: string): BoundPluginSettings {
  return React.useMemo(() => ({
    read: () => settings.read(pluginId),
    write: (value) => settings.write(pluginId, value),
  }), [settings, pluginId]);
}

export function usePluginStorage<T>(preferences: ClientPreferencesCapability, key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = React.useState<T>(() => preferences.read(key, fallback));
  const write = React.useCallback((next: T) => {
    setValue(next);
    preferences.write(key, next);
  }, [preferences, key]);
  return [value, write];
}

/**
 * 모델 로스터 구독 — 마운트(와 대상 변경)가 읽기를 시작하고, 로스터가 바뀌면 다시 그린다. 읽기 전에는 null이다.
 * 스냅샷은 캐시만 본다 — 읽기 시작은 렌더 밖(effect)에서 한다.
 */
export function useModelRoster(models: ClientModelsCapability | null | undefined, target: ModelRosterTarget): ModelRoster | null {
  React.useEffect(() => {
    void models?.load(target).catch(() => undefined);
  }, [models, target]);
  const subscribe = React.useCallback((listener: () => void) => models?.subscribe(listener) ?? (() => undefined), [models]);
  return React.useSyncExternalStore(subscribe, () => models?.read(target) ?? null, () => null);
}

export function useOperationRuntime(runtime: ClientOperationRuntimeCapability, operationId: string): BoundOperationRuntime {
  return React.useMemo(() => ({
    set: (state) => runtime.set(operationId, state),
    clear: () => runtime.clear(operationId),
  }), [runtime, operationId]);
}

export function useOperationRuntimeHydration(
  runtime: ClientOperationRuntimeCapability,
): (state: OperationRuntimeHydration, error?: string) => void {
  return React.useCallback((state, error) => runtime.setHydration(state, error), [runtime]);
}

async function assertSafeResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, `Plugin request failed: ${response.status}`, body);
  }
  return response;
}

function resolvePluginPath(pluginId: string | null, path: string): string {
  if (pluginId !== null && !/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId)) throw new ApiError(400, "Invalid plugin id");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (suffix.includes("..")) throw new ApiError(400, "Invalid plugin path");
  return pluginId === null ? `/api/v1${suffix}` : `/plugins/${pluginId}${suffix}`;
}

// 서버(core/host console-settings의 PLUGIN_ID_PATTERN)와 동일 패턴 — SDK는 core를 import할 수 없어 사본을 유지한다.
const PLUGIN_SETTINGS_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function resolvePluginSettingsPath(pluginId: string | null): string {
  if (pluginId === null) return "/api/v1/settings/execution";
  if (!PLUGIN_SETTINGS_ID_PATTERN.test(pluginId)) throw new ApiError(400, "Invalid plugin id");
  return `/api/v1/settings/plugins/${encodeURIComponent(pluginId)}`;
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
