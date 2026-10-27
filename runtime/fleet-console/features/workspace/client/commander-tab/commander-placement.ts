import { useSyncExternalStore } from "react";

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
