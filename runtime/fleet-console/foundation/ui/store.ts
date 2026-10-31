import * as React from "react";

export function useStoreSnapshot<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/* ── 떠 있는 창 겹침 — 결과물 창과 지휘관 창이 함께 쓴다 ──────────────── */

// 나중에 손댄 창이 위다. 창이 열리거나 눌릴 때 그 창을 맨 위로 올린다.
let floatingTop = 0;
const floatingZ = new Map<string, number>();
const floatingListeners = new Set<() => void>();

export function focusFloatingWindow(id: string): void {
  floatingTop += 1;
  floatingZ.set(id, floatingTop);
  for (const listener of floatingListeners) listener();
}

function subscribeFloatingWindows(listener: () => void): () => void {
  floatingListeners.add(listener);
  return () => { floatingListeners.delete(listener); };
}

function readFloatingWindowZ(id: string): number | null {
  return floatingZ.get(id) ?? null;
}

/** 그 창의 쌓임 — 한 번도 손대지 않았으면 기본값이다. */
export function useFloatingWindowZ(id: string, base: number): number {
  return React.useSyncExternalStore(
    subscribeFloatingWindows,
    () => readFloatingWindowZ(id) ?? base,
    () => base,
  );
}
