import type { ClientConsoleEventsCapability } from "@fleet-console/sdk/plugin";
import { useSyncExternalStore } from "react";

/**
 * 서버가 말하는 전역 Shell 상태(`GET /api/v1/shell/session`과 같은 모양). 절대 경로는 없다 — cwd는
 * 그것을 품은 등록 Theater와 그 안의 상대 경로로만 온다.
 */
export interface ShellSessionState {
  readonly open: boolean;
  readonly pinnedTheaterId: string | null;
  readonly cwd: { readonly theaterId: string | null; readonly relative: string | null } | null;
  readonly cwdTracked: boolean;
  readonly atPrompt: boolean;
  readonly generation: number;
}

/** 서버 `SHELL_SESSION_EVENT_CHANNEL`과 같은 이름. 브라우저는 호스트 모듈을 import하지 않는다. */
const SHELL_SESSION_EVENT_CHANNEL = "terminal:shell-session";
const SHELL_SESSION_PATH = "/api/v1/shell/session";

let snapshot: ShellSessionState | null = null;
const listeners = new Set<() => void>();
let readEpoch = 0;

function publish(next: ShellSessionState): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * 콘솔 이벤트 스트림의 push를 받고, 처음과 재연결 때마다 GET으로 다시 읽는다 — 서버는 단절 중에
 * 보낸 프레임을 다시 보내지 않는다.
 */
export function connectShellSession(events: ClientConsoleEventsCapability): () => void {
  const offEvent = events.subscribe(SHELL_SESSION_EVENT_CHANNEL, (payload) => {
    if (!isShellSessionState(payload)) return;
    // push가 진행 중인 GET보다 새 값이다 — 그 GET의 결과는 버린다.
    readEpoch += 1;
    publish(payload);
  });
  const offReconnect = events.onReconnect?.(() => { void readShellSession(); });
  void readShellSession();
  return () => {
    offEvent();
    offReconnect?.();
  };
}

/** 지금 상태를 서버에서 다시 읽는다. 실패하면 null(모름). */
export async function readShellSession(): Promise<ShellSessionState | null> {
  const epoch = ++readEpoch;
  try {
    const response = await fetch(SHELL_SESSION_PATH, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isShellSessionState(body)) return null;
    if (epoch === readEpoch) publish(body);
    return body;
  } catch {
    return null;
  }
}

export function getShellSessionSnapshot(): ShellSessionState | null {
  return snapshot;
}

export function useShellSession(): ShellSessionState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => null,
  );
}

function isShellSessionState(value: unknown): value is ShellSessionState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const cwd = record.cwd;
  return typeof record.open === "boolean"
    && (record.pinnedTheaterId === null || typeof record.pinnedTheaterId === "string")
    && typeof record.cwdTracked === "boolean"
    && typeof record.atPrompt === "boolean"
    && typeof record.generation === "number"
    && (cwd === null || (typeof cwd === "object" && cwd !== null
      && ((cwd as Record<string, unknown>).theaterId === null || typeof (cwd as Record<string, unknown>).theaterId === "string")
      && ((cwd as Record<string, unknown>).relative === null || typeof (cwd as Record<string, unknown>).relative === "string")));
}
