import { useSyncExternalStore } from "react";

export type Tier = "rail" | "list" | "detail";

interface SideBarState {
  readonly width: number;
  readonly collapsed: boolean;
}

const STORAGE_KEY_WIDTH = "fleet-console.operations.side-width";
const STORAGE_KEY_COLLAPSED = "fleet-console.operations.side-collapsed";
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

export function useSideBarState(): SideBarState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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

export function tierFromWidth(width: number): Tier {
  if (width < 120) return "rail";
  if (width < 240) return "list";
  return "detail";
}
