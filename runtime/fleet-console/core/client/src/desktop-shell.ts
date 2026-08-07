import { useSyncExternalStore } from "react";

/**
 * 창을 들고 있는 셸이 알려 준 "돌아갈 곳". 원격 콘솔이 서빙한 화면은 자기가 아닌 origin을
 * 스스로 알 수 없으므로, 이 값이 없으면 호스트 스위처에는 돌아가는 줄이 서지 않는다.
 */
type Listener = () => void;

let homeOrigin: string | null = null;
const listeners = new Set<Listener>();

export function useDesktopHomeOrigin(): string | null {
  return useSyncExternalStore(subscribe, getDesktopHomeOrigin, getDesktopHomeOrigin);
}

export function getDesktopHomeOrigin(): string | null {
  return homeOrigin;
}

export function applyDesktopShellSnapshot(value: unknown): void {
  const next = readHomeOrigin(value);
  // SSE는 재연결마다 현재 값을 다시 보낸다 — 같은 값으로 구독자를 깨우지 않는다.
  if (next === homeOrigin) return;
  homeOrigin = next;
  for (const listener of listeners) listener();
}

export function resetDesktopShellSnapshot(): void {
  applyDesktopShellSnapshot({ homeOrigin: null });
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function readHomeOrigin(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = (value as Record<string, unknown>).homeOrigin;
  if (typeof entry !== "string") return null;
  try {
    return new URL(entry).origin === entry ? entry : null;
  } catch {
    return null;
  }
}
