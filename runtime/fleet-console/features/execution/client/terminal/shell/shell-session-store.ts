import type { ClientConsoleEventsCapability } from "../../../../workspace/shared/navigation-ports.js";
import { useSyncExternalStore } from "react";

/**
 * 서버가 말하는 Shell 상태(`GET /api/v1/shell/session?shell=<key>`과 같은 모양). 절대 경로는 없다 — cwd는
 * 그것을 품은 등록 Theater와 그 안의 상대 경로로만 온다. Shell 은 대화마다 하나이고 `key`가 그 대화다.
 */
export interface ShellSessionState {
  readonly key: string;
  readonly open: boolean;
  readonly pinned: boolean;
  readonly cwd: { readonly theaterId: string | null; readonly relative: string | null } | null;
  readonly cwdTracked: boolean;
  readonly atPrompt: boolean;
  readonly generation: number;
}

/** 키 없는 옛 호출과 폰 배치가 쓰는 Console 기본 Shell. 서버의 기본 키와 같다. */
export const DEFAULT_SHELL_KEY = "console";

/** 서버 `SHELL_SESSION_EVENT_CHANNEL`과 같은 이름. 브라우저는 호스트 모듈을 import하지 않는다. */
const SHELL_SESSION_EVENT_CHANNEL = "terminal:shell-session";
const SHELL_SESSION_PATH = "/api/v1/shell/session";

let snapshots = new Map<string, ShellSessionState>();
const listeners = new Set<() => void>();
const readEpochs = new Map<string, number>();
/** 지금 보이는 대화의 Shell — 팔레트의 「여기서 Shell 열기」처럼 키를 모르는 요청이 이 Shell 로 간다. 대화 칸이 알린다. */
let activeShellKey = DEFAULT_SHELL_KEY;

function publish(next: ShellSessionState): void {
  const map = new Map(snapshots);
  map.set(next.key, next);
  snapshots = map;
  for (const listener of listeners) listener();
}

export function setActiveShellKey(key: string | null): void {
  activeShellKey = key ?? DEFAULT_SHELL_KEY;
}

export function getActiveShellKey(): string {
  return activeShellKey;
}

/**
 * 콘솔 이벤트 스트림의 push를 받고, 처음과 재연결 때마다 GET으로 다시 읽는다 — 서버는 단절 중에
 * 보낸 프레임을 다시 보내지 않는다. 다시 읽는 것은 화면이 아는 Shell 들이다.
 */
export function connectShellSession(events: ClientConsoleEventsCapability): () => void {
  const offEvent = events.subscribe(SHELL_SESSION_EVENT_CHANNEL, (payload) => {
    const state = normalize(payload);
    if (state === null) return;
    // push가 진행 중인 GET보다 새 값이다 — 그 GET의 결과는 버린다.
    readEpochs.set(state.key, (readEpochs.get(state.key) ?? 0) + 1);
    publish(state);
  });
  const reread = () => {
    const keys = new Set([DEFAULT_SHELL_KEY, activeShellKey, ...snapshots.keys()]);
    for (const key of keys) void readShellSession(key);
  };
  const offReconnect = events.onReconnect?.(reread);
  reread();
  return () => {
    offEvent();
    offReconnect?.();
  };
}

/** 그 Shell 의 지금 상태를 서버에서 다시 읽는다. 실패하면 null(모름). */
export async function readShellSession(key: string = DEFAULT_SHELL_KEY): Promise<ShellSessionState | null> {
  const epoch = (readEpochs.get(key) ?? 0) + 1;
  readEpochs.set(key, epoch);
  try {
    const response = await fetch(`${SHELL_SESSION_PATH}?shell=${encodeURIComponent(key)}`, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const body = normalize(await response.json() as unknown, key);
    if (body === null) return null;
    if (readEpochs.get(key) === epoch) publish(body);
    return body;
  } catch {
    return null;
  }
}

/** 그 Shell 을 끝낸다 — 패널을 닫는 것이 곧 Shell 을 끝내는 것이다. */
export async function endShellSession(key: string): Promise<boolean> {
  try {
    const response = await fetch(`${SHELL_SESSION_PATH}?shell=${encodeURIComponent(key)}`, { method: "DELETE" });
    return response.ok;
  } catch {
    return false;
  }
}

export function getShellSessionSnapshot(key: string = DEFAULT_SHELL_KEY): ShellSessionState | null {
  return snapshots.get(key) ?? null;
}

export function useShellSession(key: string = DEFAULT_SHELL_KEY): ShellSessionState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshots.get(key) ?? null,
    () => null,
  );
}

function normalize(value: unknown, fallbackKey: string = DEFAULT_SHELL_KEY): ShellSessionState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const cwd = record.cwd;
  const valid = typeof record.open === "boolean"
    && typeof record.pinned === "boolean"
    && typeof record.cwdTracked === "boolean"
    && typeof record.atPrompt === "boolean"
    && typeof record.generation === "number"
    && (cwd === null || (typeof cwd === "object" && cwd !== null
      && ((cwd as Record<string, unknown>).theaterId === null || typeof (cwd as Record<string, unknown>).theaterId === "string")
      && ((cwd as Record<string, unknown>).relative === null || typeof (cwd as Record<string, unknown>).relative === "string")));
  if (!valid) return null;
  const key = typeof record.key === "string" && record.key !== "" ? record.key : fallbackKey;
  return { ...(record as unknown as ShellSessionState), key };
}
