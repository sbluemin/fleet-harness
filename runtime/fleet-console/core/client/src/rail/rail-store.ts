import { useSyncExternalStore } from "react";

interface RailStore {
  readonly activeRailPanelId: string | null;
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
let store: RailStore = { activeRailPanelId: readStoredPanelId() };

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
  store = { activeRailPanelId: id };
  saveStoredPanelId(id);
  notify();
}

export function toggleRailPanel(id: string): void {
  const next = store.activeRailPanelId === id ? null : id;
  store = { activeRailPanelId: next };
  saveStoredPanelId(next);
  notify();
}

export function closeRailPanel(): void {
  if (store.activeRailPanelId === null) return;
  store = { activeRailPanelId: null };
  saveStoredPanelId(null);
  notify();
}

export function useActiveRailPanelId(): string | null {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).activeRailPanelId;
}
