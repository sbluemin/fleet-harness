import { useSyncExternalStore } from "react";

interface RailStore {
  readonly activeRailPanelId: string | null;
  readonly railChromeExpanded: boolean;
  readonly panelExtraWidth: number;
  readonly currentPanelWidth: number | null;
  readonly presetPanelWidthRequest: RailPresetPanelWidthRequest | null;
  readonly panelBehavior: "push" | "overlay";
  readonly overlayAlpha: RailOverlayAlpha;
}

export type RailOverlayAlpha = 100 | 90 | 75 | 60;
export interface RailPresetPanelWidthRequest {
  readonly panelId: string;
  readonly width: number;
  readonly revision: number;
}

type Listener = () => void;
const PREFS_ACTIVE_PANEL = "fleet-console.rail.activePanelId";
const PREFS_CHROME_EXPANDED = "fleet-console.rail.chromeExpanded";
const PREFS_PANEL_BEHAVIOR = "fleet-console.rail.panelBehavior";
const PREFS_OVERLAY_ALPHA = "fleet-console.rail.overlayAlpha";
const PREFS_REPOSITORY_SOURCE = "fleet-console.repository.source";
const listeners = new Set<Listener>();
let store: RailStore = {
  activeRailPanelId: readStoredPanelId(),
  railChromeExpanded: readStoredChromeExpanded(),
  panelExtraWidth: 0,
  currentPanelWidth: null,
  presetPanelWidthRequest: null,
  panelBehavior: readStoredPanelBehavior(),
  overlayAlpha: readStoredOverlayAlpha(),
};

export function subscribeRailStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getRailStoreSnapshot(): RailStore {
  return store;
}

export function setActiveRailPanel(id: string): void {
  if (store.activeRailPanelId === id) return;
  setStore({ ...store, activeRailPanelId: id, panelExtraWidth: 0 });
  saveStoredPanelId(id);
}

export function toggleRailPanel(id: string): void {
  const next = store.activeRailPanelId === id ? null : id;
  setStore({ ...store, activeRailPanelId: next, panelExtraWidth: 0 });
  saveStoredPanelId(next);
}

// Ensure-open: 이미 활성인 패널은 유지하고, 아니면 선택한다(toggleRailPanel과 달리 절대 닫지 않는다).
export function openRailPanel(id: string): void {
  setActiveRailPanel(id);
}

export function closeRailPanel(): void {
  if (store.activeRailPanelId === null) return;
  setStore({ ...store, activeRailPanelId: null, panelExtraWidth: 0 });
  saveStoredPanelId(null);
}

export function setRailChromeExpanded(expanded: boolean): void {
  if (store.railChromeExpanded === expanded) return;
  setStore({ ...store, railChromeExpanded: expanded });
  saveStoredChromeExpanded(expanded);
}

export function applyRailPreset(input: {
  readonly activePanelId: string | null;
  readonly chromeExpanded: boolean;
  readonly panelWidth: number | null;
}): void {
  const request = input.activePanelId !== null && input.panelWidth !== null
    ? {
      panelId: input.activePanelId,
      width: input.panelWidth,
      revision: (store.presetPanelWidthRequest?.revision ?? 0) + 1,
    }
    : null;
  setStore({
    ...store,
    activeRailPanelId: input.activePanelId,
    railChromeExpanded: input.chromeExpanded,
    panelExtraWidth: 0,
    presetPanelWidthRequest: request,
  });
  saveStoredPanelId(input.activePanelId);
  saveStoredChromeExpanded(input.chromeExpanded);
}

export function publishRailPanelWidth(panelId: string | null, width: number | null): void {
  const nextWidth = panelId === store.activeRailPanelId ? width : null;
  if (store.currentPanelWidth === nextWidth) return;
  setStore({ ...store, currentPanelWidth: nextWidth });
}

export function consumeRailPresetPanelWidth(revision: number): void {
  if (store.presetPanelWidthRequest?.revision !== revision) return;
  setStore({ ...store, presetPanelWidthRequest: null });
}

export function toggleRailChrome(): void {
  setRailChromeExpanded(!store.railChromeExpanded);
}

export function setRailPanelBehavior(behavior: "push" | "overlay"): void {
  if (store.panelBehavior === behavior) return;
  setStore({ ...store, panelBehavior: behavior });
  saveStoredPanelBehavior(behavior);
}

export function toggleRailPanelBehavior(): void {
  setRailPanelBehavior(store.panelBehavior === "push" ? "overlay" : "push");
}

export function setRailOverlayAlpha(alpha: RailOverlayAlpha): void {
  if (store.overlayAlpha === alpha) return;
  setStore({ ...store, overlayAlpha: alpha });
  saveStoredOverlayAlpha(alpha);
}

export function requestRailPanelExtraWidth(panelId: string, px: number | null): void {
  if (panelId !== store.activeRailPanelId) return;
  const raw = (px === null || !Number.isFinite(px)) ? 0 : px;
  const normalized = Math.max(0, Math.round(raw));
  const clamped = typeof window !== "undefined" ? Math.min(normalized, Math.max(0, window.innerWidth - 548)) : normalized;
  if (clamped === store.panelExtraWidth) return;
  setStore({ ...store, panelExtraWidth: clamped });
}

export function useActiveRailPanelId(): string | null {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).activeRailPanelId;
}

export function useRailChromeExpanded(): boolean {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).railChromeExpanded;
}

export function useRailPanelExtraWidth(): number {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).panelExtraWidth;
}

export function useRailPresetPanelWidthRequest(): RailPresetPanelWidthRequest | null {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).presetPanelWidthRequest;
}

export function useRailPanelBehavior(): "push" | "overlay" {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).panelBehavior;
}

export function useRailOverlayAlpha(): RailOverlayAlpha {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).overlayAlpha;
}

function readStoredPanelId(): string | null {
  try {
    const stored = localStorage.getItem(PREFS_ACTIVE_PANEL);
    if (stored === "diff" || stored === "history") {
      try {
        localStorage.setItem(PREFS_ACTIVE_PANEL, "repository");
        if (stored === "history") localStorage.setItem(PREFS_REPOSITORY_SOURCE, "history");
      } catch { /* best-effort migration */ }
      return "repository";
    }
    return stored;
  } catch { return null; }
}

function readStoredChromeExpanded(): boolean {
  try { return localStorage.getItem(PREFS_CHROME_EXPANDED) !== "0"; } catch { return true; }
}

function readStoredPanelBehavior(): "push" | "overlay" {
  try {
    const stored = localStorage.getItem(PREFS_PANEL_BEHAVIOR);
    return stored === "overlay" || stored === "push" ? stored : "push";
  } catch { return "push"; }
}

function readStoredOverlayAlpha(): RailOverlayAlpha {
  try {
    const stored = localStorage.getItem(PREFS_OVERLAY_ALPHA);
    if (stored === "90" || stored === "75" || stored === "60") return Number(stored) as RailOverlayAlpha;
    return 100;
  } catch { return 100; }
}

function saveStoredPanelId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(PREFS_ACTIVE_PANEL);
    else localStorage.setItem(PREFS_ACTIVE_PANEL, id);
  } catch { /* ignore */ }
}

function saveStoredChromeExpanded(expanded: boolean): void {
  try { localStorage.setItem(PREFS_CHROME_EXPANDED, expanded ? "1" : "0"); } catch { /* ignore */ }
}

function saveStoredPanelBehavior(behavior: "push" | "overlay"): void {
  try { localStorage.setItem(PREFS_PANEL_BEHAVIOR, behavior); } catch { /* ignore */ }
}

function saveStoredOverlayAlpha(alpha: RailOverlayAlpha): void {
  try { localStorage.setItem(PREFS_OVERLAY_ALPHA, String(alpha)); } catch { /* ignore */ }
}

function setStore(next: RailStore): void {
  store = next;
  for (const listener of listeners) listener();
}
