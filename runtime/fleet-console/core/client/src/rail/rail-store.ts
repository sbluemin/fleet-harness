import { useSyncExternalStore } from "react";

interface RailStore {
  readonly activeRailPanelId: string | null;
  readonly panelExtraWidth: number;
}

type Listener = () => void;

const PREFS_ACTIVE_PANEL = "fleet-console.rail.activePanelId";

function readStoredPanelId(): string | null {
  try { return localStorage.getItem(PREFS_ACTIVE_PANEL); } catch { return null; }
}

function saveStoredPanelId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(PREFS_ACTIVE_PANEL);
    else localStorage.setItem(PREFS_ACTIVE_PANEL, id);
  } catch { /* ignore */ }
}

const listeners = new Set<Listener>();
let store: RailStore = { activeRailPanelId: readStoredPanelId(), panelExtraWidth: 0 };

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeRailStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getRailStoreSnapshot(): RailStore {
  return store;
}

export function setActiveRailPanel(id: string): void {
  if (store.activeRailPanelId === id) return;
  store = { activeRailPanelId: id, panelExtraWidth: 0 };
  saveStoredPanelId(id);
  notify();
}

export function toggleRailPanel(id: string): void {
  const next = store.activeRailPanelId === id ? null : id;
  store = { activeRailPanelId: next, panelExtraWidth: 0 };
  saveStoredPanelId(next);
  notify();
}

export function closeRailPanel(): void {
  if (store.activeRailPanelId === null) return;
  store = { activeRailPanelId: null, panelExtraWidth: 0 };
  saveStoredPanelId(null);
  notify();
}

export function requestRailPanelExtraWidth(panelId: string, px: number | null): void {
  if (panelId !== store.activeRailPanelId) return;
  const raw = (px === null || !Number.isFinite(px)) ? 0 : px;
  const normalized = Math.max(0, Math.round(raw));
  const clamped =
    typeof window !== "undefined"
      ? Math.min(normalized, Math.max(0, window.innerWidth - 548))
      : normalized;
  if (clamped === store.panelExtraWidth) return;
  store = { ...store, panelExtraWidth: clamped };
  notify();
}

export function useActiveRailPanelId(): string | null {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).activeRailPanelId;
}

export function useRailPanelExtraWidth(): number {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).panelExtraWidth;
}
