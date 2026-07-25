import { useSyncExternalStore } from "react";

export type ViewModePreference = "auto" | "mobile" | "desktop";
export type ResolvedViewMode = "mobile" | "desktop";

export type ViewModeSnapshot = {
  readonly preference: ViewModePreference;
  readonly viewportNarrow: boolean;
  readonly effective: ResolvedViewMode;
};

type Listener = () => void;

const PREFS_VIEW_MODE = "fleet-console.view-mode.preference";
const listeners = new Set<Listener>();
let narrowViewportQuery: MediaQueryList | null = null;
let wideViewportQuery: MediaQueryList | null = null;
let store: ViewModeSnapshot = createSnapshot(readStoredPreference(), false);

initializeViewportQueries();

export function getViewModeSnapshot(): ViewModeSnapshot {
  return store;
}

export function subscribeViewMode(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useViewMode(): ViewModeSnapshot {
  return useSyncExternalStore(subscribeViewMode, getViewModeSnapshot);
}

export function setViewModePreference(preference: ViewModePreference): void {
  if (store.preference === preference) return;
  setStore(createSnapshot(preference, store.viewportNarrow));
  saveStoredPreference(preference);
}

export function cycleViewModePreference(): void {
  const next = store.preference === "auto"
    ? "mobile"
    : store.preference === "mobile"
      ? "desktop"
      : "auto";
  setViewModePreference(next);
}

function initializeViewportQueries(): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  narrowViewportQuery = window.matchMedia("(max-width: 767px)");
  wideViewportQuery = window.matchMedia("(min-width: 832px)");
  updateViewportNarrow();
  narrowViewportQuery.addEventListener("change", updateViewportNarrow);
  wideViewportQuery.addEventListener("change", updateViewportNarrow);
}

function updateViewportNarrow(): void {
  let viewportNarrow = store.viewportNarrow;
  if (narrowViewportQuery?.matches) viewportNarrow = true;
  else if (wideViewportQuery?.matches) viewportNarrow = false;
  if (viewportNarrow === store.viewportNarrow) return;
  setStore(createSnapshot(store.preference, viewportNarrow));
}

function createSnapshot(preference: ViewModePreference, viewportNarrow: boolean): ViewModeSnapshot {
  return {
    preference,
    viewportNarrow,
    effective: preference === "auto" ? (viewportNarrow ? "mobile" : "desktop") : preference,
  };
}

function readStoredPreference(): ViewModePreference {
  try {
    const stored = localStorage.getItem(PREFS_VIEW_MODE);
    return stored === "mobile" || stored === "desktop" ? stored : "auto";
  } catch { return "auto"; }
}

function saveStoredPreference(preference: ViewModePreference): void {
  try { localStorage.setItem(PREFS_VIEW_MODE, preference); } catch { /* ignore */ }
}

function setStore(next: ViewModeSnapshot): void {
  store = next;
  for (const listener of listeners) listener();
}
