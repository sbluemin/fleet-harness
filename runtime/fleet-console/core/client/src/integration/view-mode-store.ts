import { useSyncExternalStore } from "react";
import { isFleetMobileShell } from "@fleet-console/link/core";
import { createListenerSet } from "./listener-set.js";

export type ResolvedViewMode = "mobile" | "desktop";

export type ViewModeSnapshot = {
  readonly viewportNarrow: boolean;
  readonly effective: ResolvedViewMode;
};

const listeners = createListenerSet();
let narrowViewportQuery: MediaQueryList | null = null;
let wideViewportQuery: MediaQueryList | null = null;

// The Fleet Mobile shell stamps its user agent (detection lives in foundation/link so features can
// read it too). That shell is mobile. An Electron renderer is always desktop. Every other browser
// follows the viewport: mobile at max-width 767px, desktop at min-width 832px, and the previous
// layout in between. A page first opened in that gap starts on desktop.
const fleetMobileShell = isFleetMobileShell();
const desktopShell = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

let store: ViewModeSnapshot = createSnapshot(false);

initializeViewportQueries();

export function getViewModeSnapshot(): ViewModeSnapshot {
  return store;
}

export const subscribeViewMode = listeners.subscribe;

export function useViewMode(): ViewModeSnapshot {
  return useSyncExternalStore(subscribeViewMode, getViewModeSnapshot);
}

/** Test-only. Overrides the viewport input; device rules still decide the layout. */
export function __setViewportNarrowForTests(viewportNarrow: boolean): void {
  if (store.viewportNarrow === viewportNarrow) return;
  setStore(createSnapshot(viewportNarrow));
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
  setStore(createSnapshot(viewportNarrow));
}

function createSnapshot(viewportNarrow: boolean): ViewModeSnapshot {
  return {
    viewportNarrow,
    effective: desktopShell ? "desktop" : (fleetMobileShell || viewportNarrow ? "mobile" : "desktop"),
  };
}

function setStore(next: ViewModeSnapshot): void {
  store = next;
  listeners.emit();
}

/** 좌측 사이드바가 지금 화면에 보이는가 — 사이드바는 접히지 않으므로 모바일 셸에서만 없다. */
export function useHostSideBarVisible(): boolean {
  return useViewMode().effective !== "mobile";
}
