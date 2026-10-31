import { useSyncExternalStore } from "react";

/** 지휘관 목록이 서는 사이드바. 왼쪽이 기본이다. */
export type CommanderPlacement = "left" | "right";

const KEY = "fleet-console.commanderList.place";
const LEGACY_SIDE_KEY = "fleet-console.commanderRail.side";
const RAIL_EXPANDED_KEY = "fleet-console.commanderList.expanded";
// 거둔 떠 있는 지휘관 창의 크기 기억 — 읽는 김에 지운다. 값은 따로 쓰지 않는다.
const LEGACY_WINDOW_RECT_KEY = "fleet-console.commanderWindow.rect";

export function readCommanderPlacement(): CommanderPlacement {
  try {
    if (typeof window === "undefined") return "left";
    // 고스팅 레일 잔재는 읽는 김에 지운다 — 값은 따로 쓰지 않는다.
    window.localStorage.removeItem(LEGACY_SIDE_KEY);
    window.localStorage.removeItem(RAIL_EXPANDED_KEY);
    window.localStorage.removeItem(LEGACY_WINDOW_RECT_KEY);
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return "left";
    const parsed: unknown = JSON.parse(raw);
    if (parsed === "left" || parsed === "right") return parsed;
    // 예전 저장값(사이드바·채팅 안)은 모두 왼쪽으로 모은다.
    window.localStorage.setItem(KEY, JSON.stringify("left"));
    return "left";
  } catch {
    return "left";
  }
}

let placement = readCommanderPlacement();
const listeners = new Set<() => void>();

export function setCommanderPlacement(next: CommanderPlacement): void {
  if (placement === next) return;
  placement = next;
  try { window.localStorage.setItem(KEY, JSON.stringify(placement)); } catch { /* 저장하지 못하면 이번 화면에서만 기억한다. */ }
  for (const listener of listeners) listener();
}

export function useCommanderPlacement(): CommanderPlacement {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => placement,
    () => placement,
  );
}

/* ── 옮기기 알림 — 목록이 반대쪽으로 넘어가며 언마운트돼도 살아남는다 ────── */

// 옮기는 순간 그 목록(사이드바 섹션·작업 탭 목표 섹션)이 언마운트되므로, 알림은 저장소 모듈에 두고 한 곳에서만 그린다.
export interface CommanderPlacementNotice {
  readonly commodoreId: string;
  readonly next: CommanderPlacement;
  readonly prev: CommanderPlacement;
  readonly nonce: number;
}

let notice: CommanderPlacementNotice | null = null;
const noticeListeners = new Set<() => void>();
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function emitNotice(): void {
  for (const listener of noticeListeners) listener();
}

export function notifyCommanderPlacementMoved(commodoreId: string, next: CommanderPlacement, prev: CommanderPlacement): void {
  if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null; }
  notice = { commodoreId, next, prev, nonce: Date.now() };
  emitNotice();
  noticeTimer = setTimeout(() => { notice = null; noticeTimer = null; emitNotice(); }, 5000);
}

export function dismissCommanderPlacementNotice(): void {
  if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null; }
  if (notice === null) return;
  notice = null;
  emitNotice();
}

export function useCommanderPlacementNotice(): CommanderPlacementNotice | null {
  return useSyncExternalStore(
    (listener) => { noticeListeners.add(listener); return () => { noticeListeners.delete(listener); }; },
    () => notice,
    () => null,
  );
}
