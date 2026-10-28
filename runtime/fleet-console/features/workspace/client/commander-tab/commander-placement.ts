import { useSyncExternalStore } from "react";

import { useSideBarState } from "../sidebar/objective-records-side-bar-store.js";

/** 지휘관 목록이 서는 곳. 채팅 안일 때만 side 를 쓴다. 기본은 사이드바다. */
export type CommanderPlace = "sidebar" | "chat";
export type CommanderSide = "left" | "right";

export interface CommanderPlacement {
  readonly place: CommanderPlace;
  readonly side: CommanderSide;
}

const KEY = "fleet-console.commanderList.place";
const LEGACY_SIDE_KEY = "fleet-console.commanderRail.side";
const DEFAULT_PLACEMENT: CommanderPlacement = { place: "sidebar", side: "right" };

export function readCommanderPlacement(): CommanderPlacement {
  try {
    if (typeof window === "undefined") return DEFAULT_PLACEMENT;
    const raw = window.localStorage.getItem(KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<CommanderPlacement>;
      return {
        place: parsed.place === "chat" ? "chat" : "sidebar",
        side: parsed.side === "left" ? "left" : "right",
      };
    }
    const legacy = window.localStorage.getItem(LEGACY_SIDE_KEY);
    if (legacy === "left" || legacy === "right") return { place: "chat", side: legacy };
    return DEFAULT_PLACEMENT;
  } catch {
    return DEFAULT_PLACEMENT;
  }
}

let placement = readCommanderPlacement();
const listeners = new Set<() => void>();

export function setCommanderPlacement(next: CommanderPlacement): void {
  if (placement.place === next.place && placement.side === next.side) return;
  placement = { place: next.place, side: next.side };
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

/** 고스팅 레일 펼침 상태. 사령관을 옮겨도(재마운트) 유지되도록 컴포넌트 밖에서 기억한다. 기본은 접힘. */
const RAIL_EXPANDED_KEY = "fleet-console.commanderList.expanded";

export function readCommanderRailExpanded(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(RAIL_EXPANDED_KEY) === "true";
  } catch {
    return false;
  }
}

let railExpanded = readCommanderRailExpanded();
const railExpandedListeners = new Set<() => void>();

export function setCommanderRailExpanded(next: boolean): void {
  if (railExpanded === next) return;
  railExpanded = next;
  try { window.localStorage.setItem(RAIL_EXPANDED_KEY, String(next)); } catch { /* 저장하지 못하면 이번 화면에서만 기억한다. */ }
  for (const listener of railExpandedListeners) listener();
}

export function useCommanderRailExpanded(): boolean {
  return useSyncExternalStore(
    (listener) => { railExpandedListeners.add(listener); return () => { railExpandedListeners.delete(listener); }; },
    () => railExpanded,
    () => railExpanded,
  );
}

/** 좁은 창에서는 사이드바 목록이 사라지므로, 저장값은 그대로 두고 채팅 레일로 보여 준다. */
export function effectiveCommanderPlacement(stored: CommanderPlacement, compact: boolean): CommanderPlacement {
  if (compact && stored.place === "sidebar") return { place: "chat", side: stored.side };
  return stored;
}

export function useEffectiveCommanderPlacement(): CommanderPlacement {
  return effectiveCommanderPlacement(useCommanderPlacement(), useSideBarState().compact);
}
