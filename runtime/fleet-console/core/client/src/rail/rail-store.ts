import { useSyncExternalStore } from "react";

import type { RailPathContext } from "@fleet-console/sdk/rail";

interface RailPathContextState {
  readonly context: RailPathContext | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

interface RailStore {
  readonly activeRailPanelId: string | null;
  readonly panelExtraWidth: number;
  readonly pathContextTheaterId: string | null;
  readonly pathContext: RailPathContext | null;
  readonly pathContextLoading: boolean;
  readonly pathContextError: string | null;
  readonly isPathContextDeckOpen: boolean;
}

type Listener = () => void;
type PathContextLoader = (signal: AbortSignal) => Promise<RailPathContext>;
type PathContextSaver = (signal: AbortSignal) => Promise<RailPathContext>;

const PREFS_ACTIVE_PANEL = "fleet-console.rail.activePanelId";
const listeners = new Set<Listener>();
const pathContexts = new Map<string, RailPathContextState>();
let activePathRequest: AbortController | null = null;
let activePathGeneration = 0;
let store: RailStore = {
  activeRailPanelId: readStoredPanelId(),
  panelExtraWidth: 0,
  pathContextTheaterId: null,
  pathContext: null,
  pathContextLoading: false,
  pathContextError: null,
  isPathContextDeckOpen: false,
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
  setStore({ ...store, activeRailPanelId: id, panelExtraWidth: 0, isPathContextDeckOpen: false });
  saveStoredPanelId(id);
}

export function toggleRailPanel(id: string): void {
  const next = store.activeRailPanelId === id ? null : id;
  setStore({ ...store, activeRailPanelId: next, panelExtraWidth: 0, isPathContextDeckOpen: false });
  saveStoredPanelId(next);
}

export function closeRailPanel(): void {
  if (store.activeRailPanelId === null) return;
  setStore({ ...store, activeRailPanelId: null, panelExtraWidth: 0, isPathContextDeckOpen: false });
  saveStoredPanelId(null);
}

export function requestRailPanelExtraWidth(panelId: string, px: number | null): void {
  if (panelId !== store.activeRailPanelId) return;
  const raw = (px === null || !Number.isFinite(px)) ? 0 : px;
  const normalized = Math.max(0, Math.round(raw));
  const clamped = typeof window !== "undefined" ? Math.min(normalized, Math.max(0, window.innerWidth - 548)) : normalized;
  if (clamped === store.panelExtraWidth) return;
  setStore({ ...store, panelExtraWidth: clamped });
}

export function selectRailPathContextTheater(theaterId: string | null): void {
  activePathRequest?.abort();
  activePathRequest = null;
  activePathGeneration += 1;
  const state = theaterId ? pathContexts.get(theaterId) : undefined;
  setStore({
    ...store,
    pathContextTheaterId: theaterId,
    pathContext: state?.context ?? null,
    pathContextLoading: state?.isLoading ?? false,
    pathContextError: state?.error ?? null,
    isPathContextDeckOpen: false,
  });
}

export async function hydrateRailPathContext(theaterId: string, load: PathContextLoader): Promise<void> {
  if (store.pathContextTheaterId !== theaterId) selectRailPathContextTheater(theaterId);
  activePathRequest?.abort();
  const controller = new AbortController();
  activePathRequest = controller;
  const generation = ++activePathGeneration;
  pathContexts.set(theaterId, { context: null, isLoading: true, error: null });
  if (store.pathContextTheaterId === theaterId) setStore({ ...store, pathContext: null, pathContextLoading: true, pathContextError: null });
  try {
    const context = await load(controller.signal);
    if (controller.signal.aborted || generation !== activePathGeneration) return;
    const state = { context, isLoading: false, error: null };
    pathContexts.set(theaterId, state);
    if (store.pathContextTheaterId === theaterId) setStore({ ...store, pathContext: context, pathContextLoading: false, pathContextError: null });
  } catch (error) {
    if (controller.signal.aborted || generation !== activePathGeneration) return;
    const message = error instanceof Error ? error.message : "Unable to load path context";
    pathContexts.set(theaterId, { context: null, isLoading: false, error: message });
    if (store.pathContextTheaterId === theaterId) setStore({ ...store, pathContext: null, pathContextLoading: false, pathContextError: message });
  }
}

export async function mutateRailPathContext(theaterId: string, save: PathContextSaver): Promise<RailPathContext | null> {
  if (store.pathContextTheaterId !== theaterId) return null;
  activePathRequest?.abort();
  const controller = new AbortController();
  activePathRequest = controller;
  const generation = ++activePathGeneration;
  setStore({ ...store, pathContextLoading: true, pathContextError: null });
  try {
    const context = await save(controller.signal);
    if (controller.signal.aborted || generation !== activePathGeneration || store.pathContextTheaterId !== theaterId) return null;
    pathContexts.set(theaterId, { context, isLoading: false, error: null });
    setStore({ ...store, pathContext: context, pathContextLoading: false, pathContextError: null, isPathContextDeckOpen: false });
    return context;
  } catch (error) {
    if (controller.signal.aborted || generation !== activePathGeneration) return null;
    const message = error instanceof Error ? error.message : "Unable to save path context";
    pathContexts.set(theaterId, { context: store.pathContext, isLoading: false, error: message });
    setStore({ ...store, pathContextLoading: false, pathContextError: message });
    return null;
  }
}

export function setRailPathContextDeckOpen(open: boolean): void {
  if (open === store.isPathContextDeckOpen) return;
  setStore({ ...store, isPathContextDeckOpen: open });
}

export function useActiveRailPanelId(): string | null {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).activeRailPanelId;
}

export function useRailPanelExtraWidth(): number {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).panelExtraWidth;
}

export function useRailPathContextStore(): Pick<RailStore, "pathContext" | "pathContextLoading" | "pathContextError" | "isPathContextDeckOpen"> {
  const snapshot = useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot);
  return snapshot;
}

function readStoredPanelId(): string | null {
  try { return localStorage.getItem(PREFS_ACTIVE_PANEL); } catch { return null; }
}

function saveStoredPanelId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(PREFS_ACTIVE_PANEL);
    else localStorage.setItem(PREFS_ACTIVE_PANEL, id);
  } catch { /* ignore */ }
}

function setStore(next: RailStore): void {
  store = next;
  for (const listener of listeners) listener();
}
