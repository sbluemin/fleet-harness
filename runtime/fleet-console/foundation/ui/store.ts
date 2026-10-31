import * as React from "react";

export function useStoreSnapshot<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/* ── 떠 있는 창 겹침 — 결과물 창과 지휘관 창이 함께 쓴다 ──────────────── */

// 나중에 손댄 창이 위다. 기본 층(결과물 창과 같은 59)은 지키고, 창 수만큼만 그 위로 쌓는다.
const floatingOrder: string[] = [];
const floatingListeners = new Set<() => void>();

export function focusFloatingWindow(id: string): void {
  const at = floatingOrder.indexOf(id);
  if (at >= 0) floatingOrder.splice(at, 1);
  floatingOrder.push(id);
  for (const listener of floatingListeners) listener();
}

function subscribeFloatingWindows(listener: () => void): () => void {
  floatingListeners.add(listener);
  return () => { floatingListeners.delete(listener); };
}

function readFloatingWindowRank(id: string): number {
  const rank = floatingOrder.indexOf(id);
  return rank < 0 ? 0 : rank;
}

/** 그 창의 쌓임 — 기본 층에 창 순서를 더한다. 손댄 적 없으면 기본 층이다. */
export function useFloatingWindowZ(id: string, base: number): number {
  return React.useSyncExternalStore(
    subscribeFloatingWindows,
    () => base + readFloatingWindowRank(id),
    () => base,
  );
}
