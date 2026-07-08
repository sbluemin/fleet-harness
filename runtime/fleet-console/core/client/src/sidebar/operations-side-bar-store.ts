import { useSyncExternalStore } from "react";

export type Tier = "rail" | "list" | "detail";

interface SideBarState {
  readonly width: number;
  readonly collapsed: boolean;
}

const STORAGE_KEY_WIDTH = "fleet-console.operations.side-width";
const STORAGE_KEY_COLLAPSED = "fleet-console.operations.side-collapsed";
const STORAGE_KEY_THEATER_COLLAPSED = "fleet-console.operations.theater-collapsed";
export const MIN_RAIL_PX = 56;
export const MIN_LIST_PX = 180;
export const MIN_DETAIL_PX = 280;
const DEFAULT_WIDTH = MIN_LIST_PX;

function getMaxPx(): number {
  return typeof window !== "undefined" ? window.innerWidth - 480 : 800;
}

function readInitialWidth(): number {
  try {
    if (typeof window === "undefined") return DEFAULT_WIDTH;
    const v = localStorage.getItem(STORAGE_KEY_WIDTH);
    if (v !== null) {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n >= MIN_RAIL_PX) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_WIDTH;
}

function readInitialCollapsed(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY_COLLAPSED) === "1";
  } catch { /* ignore */ }
  return false;
}

let sideBarState: SideBarState = {
  width: readInitialWidth(),
  collapsed: readInitialCollapsed(),
};
const sideBarListeners = new Set<() => void>();
let collapsedTheaterIds = readInitialCollapsedTheaters();
const collapsedTheaterListeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of sideBarListeners) listener();
}

function getSnapshot(): SideBarState {
  return sideBarState;
}

function subscribe(listener: () => void): () => void {
  sideBarListeners.add(listener);
  return () => {
    sideBarListeners.delete(listener);
  };
}

function readInitialCollapsedTheaters(): readonly string[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_KEY_THEATER_COLLAPSED);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch { /* ignore */ }
  return [];
}

function notifyCollapsedTheaterListeners(): void {
  for (const listener of collapsedTheaterListeners) listener();
}

function getCollapsedTheatersSnapshot(): readonly string[] {
  return collapsedTheaterIds;
}

function subscribeCollapsedTheaters(listener: () => void): () => void {
  collapsedTheaterListeners.add(listener);
  return () => {
    collapsedTheaterListeners.delete(listener);
  };
}

export function useSideBarState(): SideBarState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useCollapsedTheaters(): readonly string[] {
  return useSyncExternalStore(subscribeCollapsedTheaters, getCollapsedTheatersSnapshot, getCollapsedTheatersSnapshot);
}

export function setSideBarWidth(width: number): void {
  const clamped = Math.max(MIN_RAIL_PX, Math.min(getMaxPx(), width));
  sideBarState = { ...sideBarState, width: clamped };
  try {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped));
  } catch { /* ignore */ }
  notifyListeners();
}

export function setSideBarCollapsed(collapsed: boolean): void {
  sideBarState = { ...sideBarState, collapsed };
  try {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY_COLLAPSED, collapsed ? "1" : "0");
  } catch { /* ignore */ }
  notifyListeners();
}

export function setTheaterCollapsed(theaterId: string, collapsed: boolean): void {
  const current = new Set(collapsedTheaterIds);
  if (collapsed) {
    current.add(theaterId);
  } else {
    current.delete(theaterId);
  }
  const next = Array.from(current);
  if (next.join("\0") === collapsedTheaterIds.join("\0")) return;
  collapsedTheaterIds = next;
  try {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY_THEATER_COLLAPSED, JSON.stringify(next));
  } catch { /* ignore */ }
  notifyCollapsedTheaterListeners();
}

export function tierFromWidth(width: number): Tier {
  if (width < 120) return "rail";
  if (width < 240) return "list";
  return "detail";
}
