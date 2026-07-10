import { useSyncExternalStore } from "react";

interface SideBarState {
  readonly width: number;
  readonly collapsed: boolean;
}

const STORAGE_KEY_WIDTH = "fleet-console.operations.side-width";
const STORAGE_KEY_COLLAPSED = "fleet-console.operations.side-collapsed";
const STORAGE_KEY_THEATER_COLLAPSED = "fleet-console.operations.theater-collapsed";
export const MIN_EXPANDED_PX = 280;
const DEFAULT_WIDTH = MIN_EXPANDED_PX;

const sideBarListeners = new Set<() => void>();
const collapsedTheaterListeners = new Set<() => void>();

let sideBarState: SideBarState = {
  width: readInitialWidth(),
  collapsed: readInitialCollapsed(),
};
let collapsedTheaterIds = readInitialCollapsedTheaters();

export function useSideBarState(): SideBarState {
  return useSyncExternalStore(subscribeSideBarState, getSideBarState, getSideBarState);
}

export function useCollapsedTheaters(): readonly string[] {
  return useSyncExternalStore(subscribeCollapsedTheaters, getCollapsedTheatersSnapshot, getCollapsedTheatersSnapshot);
}

export function setSideBarWidth(width: number): void {
  const clamped = Math.max(MIN_EXPANDED_PX, Math.min(getMaxPx(), width));
  if (sideBarState.width === clamped) return;
  sideBarState = { ...sideBarState, width: clamped };
  try {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped));
  } catch { /* ignore */ }
  notifyListeners();
}

export function setSideBarCollapsed(collapsed: boolean): void {
  if (sideBarState.collapsed === collapsed) return;
  sideBarState = { ...sideBarState, collapsed };
  try {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY_COLLAPSED, collapsed ? "1" : "0");
  } catch { /* ignore */ }
  notifyListeners();
}

export function setTheaterCollapsed(theaterId: string, collapsed: boolean): void {
  const current = new Set(collapsedTheaterIds);
  if (collapsed) current.add(theaterId);
  else current.delete(theaterId);
  const next = Array.from(current);
  if (next.join("\0") === collapsedTheaterIds.join("\0")) return;
  collapsedTheaterIds = next;
  try {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY_THEATER_COLLAPSED, JSON.stringify(next));
  } catch { /* ignore */ }
  notifyCollapsedTheaterListeners();
}

function getMaxPx(): number {
  return typeof window !== "undefined" ? Math.max(MIN_EXPANDED_PX, window.innerWidth - 480) : 800;
}

function readInitialWidth(): number {
  try {
    if (typeof window === "undefined") return DEFAULT_WIDTH;
    const value = localStorage.getItem(STORAGE_KEY_WIDTH);
    if (value !== null) {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) return Math.max(MIN_EXPANDED_PX, Math.min(getMaxPx(), parsed));
    }
  } catch { /* ignore */ }
  return DEFAULT_WIDTH;
}

function readInitialCollapsed(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY_COLLAPSED) === "1";
  } catch { return false; }
}

function readInitialCollapsedTheaters(): readonly string[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_KEY_THEATER_COLLAPSED);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
}

function notifyListeners(): void {
  for (const listener of sideBarListeners) listener();
}

export function getSideBarState(): SideBarState {
  return sideBarState;
}

export function subscribeSideBarState(listener: () => void): () => void {
  sideBarListeners.add(listener);
  return () => sideBarListeners.delete(listener);
}

function notifyCollapsedTheaterListeners(): void {
  for (const listener of collapsedTheaterListeners) listener();
}

function getCollapsedTheatersSnapshot(): readonly string[] {
  return collapsedTheaterIds;
}

function subscribeCollapsedTheaters(listener: () => void): () => void {
  collapsedTheaterListeners.add(listener);
  return () => collapsedTheaterListeners.delete(listener);
}
