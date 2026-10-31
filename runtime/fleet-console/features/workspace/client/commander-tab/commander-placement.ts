import { useSyncExternalStore } from "react";

/** 지휘관 목록이 서는 사이드바. 왼쪽이 기본이다. */
export type CommanderPlacement = "left" | "right";

const KEY = "fleet-console.commanderList.place";
const LEGACY_SIDE_KEY = "fleet-console.commanderRail.side";
const RAIL_EXPANDED_KEY = "fleet-console.commanderList.expanded";

export function readCommanderPlacement(): CommanderPlacement {
  try {
    if (typeof window === "undefined") return "left";
    // 고스팅 레일 잔재는 읽는 김에 지운다 — 값은 따로 쓰지 않는다.
    window.localStorage.removeItem(LEGACY_SIDE_KEY);
    window.localStorage.removeItem(RAIL_EXPANDED_KEY);
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
