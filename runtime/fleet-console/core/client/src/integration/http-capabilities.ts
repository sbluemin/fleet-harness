import { resolveOwnerForContext } from "../../../../features/commodore/shared/contracts/client-helpers.js";
import { requestShellOpenAt, requestShellRestartAt } from "../../../../features/workspace/client/navigation-events.js";
import * as React from "react";
import { assertObjectiveRecord, ApiError } from "../../../../features/execution/client/objective-records.js";
import type { ObjectiveRecord } from "../../../../features/objectives/shared/records/types.js";
import type { ModelRoster, ModelRosterTarget } from "../../../../features/ai-gateway/shared/models.js";
import type { ConsoleClientCapabilities } from "./client-capabilities.js";


export function createClientCapabilities(resync: () => void = () => undefined): ConsoleClientCapabilities {
  const disposables = new Set<() => void>();
  return {
    api: {
      fetch: (path, init) => fetch(resolveApiPath(path), init).then(assertSafeResponse),
      subscribe: (path, onMessage) => {
        const source = new EventSource(resolveApiPath(path));
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
    chat: { Transcript: () => null, Conversation: () => null, DecisionCard: () => null, Ledger: () => null },
    terminal: {
      requestTicket: async (path, objectiveId, signal) => {
        const response = await fetch(resolveApiPath(path), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ objectiveId }),
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
      getObjectiveRecords: () => [],
      getActiveTheaterId: () => null,
      getViewedTheaterId: () => null,
      viewTheater: () => undefined,
      getActiveObjectiveId: () => null,
      // 스트림이 없는 사본은 끊긴 적도 없다 — offline 으로 두면 플러그인이 영원히 단절로 읽는다.
      getConnection: () => "live",
      // 런타임 축을 보고하는 권위자가 없는 사본은 기다릴 것도 없다 — 호스트 스토어의 기본값과 같다.
      getObjectiveRuntimeHydration: () => "ready",
      getSelectedObjectiveId: () => null,
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
    objectiveRecords: {
      create: async (input) => {
        const response = await fetch("/api/v1/objectives/records", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, commodoreId: await resolveOwnerForContext(input.theaterId) }),
        });
        if (!response.ok) throw new ApiError(response.status, `Objective create failed: ${response.status}`);
        const payload = await response.json() as { readonly objectiveRecord?: unknown };
        return assertObjectiveRecord(payload.objectiveRecord);
      },
      rename: async (objectiveId, title) => {
        const response = await fetch(`/api/v1/objectives/records/${encodeURIComponent(objectiveId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        if (!response.ok) throw new ApiError(response.status, `Objective rename failed: ${response.status}`);
        const payload = await response.json() as { readonly objectiveRecord?: unknown };
        return assertObjectiveRecord(payload.objectiveRecord);
      },
      remove: async (objectiveId) => {
        const response = await fetch(`/api/v1/objectives/records/${encodeURIComponent(objectiveId)}`, { method: "DELETE" });
        if (!response.ok) throw new ApiError(response.status, `Objective remove failed: ${response.status}`);
      },
      focus: () => undefined,
    },
    preferences: {
      read: (key, fallback) => readPreference(key, fallback),
      write: (key, value) => writePreference(key, value),
    },
    settings: {
      read: async () => {
        const response = await fetch(resolveExecutionSettingsPath());
        if (!response.ok) throw new ApiError(response.status, `Plugin settings read failed: ${response.status}`);
        const payload = await response.json() as { readonly value?: unknown };
        const value = payload.value;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
        return null;
      },
      write: async (value) => {
        const response = await fetch(resolveExecutionSettingsPath(), {
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


async function assertSafeResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, `Plugin request failed: ${response.status}`, body);
  }
  return response;
}


function resolveApiPath(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (suffix.includes("..")) throw new ApiError(400, "Invalid API path");
  return `/api/v1${suffix}`;
}
function resolveExecutionSettingsPath(): string { return "/api/v1/settings/execution"; }

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
