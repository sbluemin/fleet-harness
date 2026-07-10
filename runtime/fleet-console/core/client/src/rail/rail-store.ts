import { useSyncExternalStore } from "react";

import type { RailPathContext } from "@fleet-console/sdk/rail";

interface RailPathContextState {
  readonly context: RailPathContext | null;
  readonly isHydrated: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
}

interface RailStore {
  readonly activeRailPanelId: string | null;
  readonly railChromeExpanded: boolean;
  readonly panelExtraWidth: number;
  readonly pathContextTheaterId: string | null;
  readonly pathContext: RailPathContext | null;
  readonly pathContextHydrated: boolean;
  readonly pathContextLoading: boolean;
  readonly pathContextMutationInProgress: boolean;
  readonly pathContextError: string | null;
  readonly isPathContextDeckOpen: boolean;
}

type Listener = () => void;
type PathContextLoader = (signal: AbortSignal) => Promise<RailPathContext>;
type PathContextSaver = (signal: AbortSignal) => Promise<RailPathContext>;

const PREFS_ACTIVE_PANEL = "fleet-console.rail.activePanelId";
const PREFS_CHROME_EXPANDED = "fleet-console.rail.chromeExpanded";
const listeners = new Set<Listener>();
const pathContexts = new Map<string, RailPathContextState>();
const pathContextMutationChains = new Map<string, Promise<void>>();
const pendingPathContextMutations = new Map<string, number>();
const pathContextMutationRevisions = new Map<string, number>();
let activePathRequest: AbortController | null = null;
let activePathGeneration = 0;
let store: RailStore = {
  activeRailPanelId: readStoredPanelId(),
  railChromeExpanded: readStoredChromeExpanded(),
  panelExtraWidth: 0,
  pathContextTheaterId: null,
  pathContext: null,
  pathContextHydrated: false,
  pathContextLoading: false,
  pathContextMutationInProgress: false,
  pathContextError: null,
  isPathContextDeckOpen: false,
};

// Theater가 없으면 경로 컨텍스트 자체가 존재하지 않으므로 hydrate 게이트를 적용하지 않는다 —
// 패널은 자체 no-Theater 상태를 렌더해야 한다(게이트 목적은 '다른 Theater의 stale 컨텍스트 차단'뿐).
export function canRenderPathAwarePanelBody(pathAware: boolean, theaterId: string | null, hasHydratedPathContext: boolean): boolean {
  return !pathAware || theaterId === null || hasHydratedPathContext;
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

export function setRailChromeExpanded(expanded: boolean): void {
  if (store.railChromeExpanded === expanded) return;
  setStore({ ...store, railChromeExpanded: expanded, isPathContextDeckOpen: false });
  saveStoredChromeExpanded(expanded);
}

export function toggleRailChrome(): void {
  setRailChromeExpanded(!store.railChromeExpanded);
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
    pathContextHydrated: state?.isHydrated ?? false,
    pathContextLoading: state?.isLoading ?? false,
    pathContextMutationInProgress: theaterId !== null && hasPendingPathContextMutation(theaterId),
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
  const mutationRevision = pathContextMutationRevisions.get(theaterId) ?? 0;
  pathContexts.set(theaterId, { context: null, isHydrated: false, isLoading: true, error: null });
  if (store.pathContextTheaterId === theaterId) setStore({ ...store, pathContext: null, pathContextHydrated: false, pathContextLoading: true, pathContextError: null });
  try {
    // A → B → A 복귀처럼 hydrate가 기존 PUT보다 늦게 시작되면, 서버가 PUT 이전 상태를
    // 읽은 GET을 만드는 일을 막기 위해 해당 Theater의 직렬 mutation chain 뒤에 붙인다.
    await (pathContextMutationChains.get(theaterId) ?? Promise.resolve());
    if (controller.signal.aborted || generation !== activePathGeneration) return;
    const context = await load(controller.signal);
    // hydrate가 GET을 시작한 뒤 새 PUT이 예약되면, 응답은 현재 generation이어도 stale이다.
    if (controller.signal.aborted || generation !== activePathGeneration || mutationRevision !== (pathContextMutationRevisions.get(theaterId) ?? 0)) return;
    const state = { context, isHydrated: true, isLoading: false, error: null };
    pathContexts.set(theaterId, state);
    if (store.pathContextTheaterId === theaterId) setStore({ ...store, pathContext: context, pathContextHydrated: true, pathContextLoading: false, pathContextError: null });
  } catch (error) {
    if (controller.signal.aborted || generation !== activePathGeneration || mutationRevision !== (pathContextMutationRevisions.get(theaterId) ?? 0)) return;
    const message = error instanceof Error ? error.message : "Unable to load path context";
    pathContexts.set(theaterId, { context: null, isHydrated: false, isLoading: false, error: message });
    if (store.pathContextTheaterId === theaterId) setStore({ ...store, pathContext: null, pathContextHydrated: false, pathContextLoading: false, pathContextError: message });
  }
}

export async function mutateRailPathContext(theaterId: string, save: PathContextSaver): Promise<RailPathContext | null> {
  if (store.pathContextTheaterId !== theaterId) return null;
  pathContextMutationRevisions.set(theaterId, (pathContextMutationRevisions.get(theaterId) ?? 0) + 1);
  incrementPendingPathContextMutations(theaterId);
  const previous = pathContextMutationChains.get(theaterId) ?? Promise.resolve();
  const mutation = previous.then(() => persistRailPathContextMutation(theaterId, save));
  pathContextMutationChains.set(theaterId, mutation.then(() => undefined));
  return mutation;
}

export function setRailPathContextDeckOpen(open: boolean): void {
  if (open === store.isPathContextDeckOpen) return;
  setStore({ ...store, isPathContextDeckOpen: open });
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

export function useRailPathContextStore(): Pick<RailStore, "pathContextTheaterId" | "pathContext" | "pathContextHydrated" | "pathContextLoading" | "pathContextMutationInProgress" | "pathContextError" | "isPathContextDeckOpen"> {
  const snapshot = useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot);
  return snapshot;
}

function readStoredPanelId(): string | null {
  try { return localStorage.getItem(PREFS_ACTIVE_PANEL); } catch { return null; }
}

function readStoredChromeExpanded(): boolean {
  try { return localStorage.getItem(PREFS_CHROME_EXPANDED) !== "0"; } catch { return true; }
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

async function persistRailPathContextMutation(theaterId: string, save: PathContextSaver): Promise<RailPathContext | null> {
  try {
    const context = await save(new AbortController().signal);
    const state = { context, isHydrated: true, isLoading: false, error: null };
    pathContexts.set(theaterId, state);
    if (store.pathContextTheaterId === theaterId) {
      setStore({ ...store, pathContext: context, pathContextHydrated: true, pathContextLoading: false, pathContextError: null, isPathContextDeckOpen: false });
    }
    return context;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save path context";
    const current = pathContexts.get(theaterId);
    pathContexts.set(theaterId, { context: current?.context ?? null, isHydrated: current?.isHydrated ?? false, isLoading: false, error: message });
    if (store.pathContextTheaterId === theaterId) setStore({ ...store, pathContextError: message });
    return null;
  } finally {
    decrementPendingPathContextMutations(theaterId);
  }
}

function hasPendingPathContextMutation(theaterId: string): boolean {
  return (pendingPathContextMutations.get(theaterId) ?? 0) > 0;
}

function incrementPendingPathContextMutations(theaterId: string): void {
  pendingPathContextMutations.set(theaterId, (pendingPathContextMutations.get(theaterId) ?? 0) + 1);
  if (store.pathContextTheaterId === theaterId) setStore({ ...store, pathContextMutationInProgress: true, pathContextError: null });
}

function decrementPendingPathContextMutations(theaterId: string): void {
  const next = (pendingPathContextMutations.get(theaterId) ?? 1) - 1;
  if (next > 0) pendingPathContextMutations.set(theaterId, next);
  else pendingPathContextMutations.delete(theaterId);
  if (store.pathContextTheaterId === theaterId) setStore({ ...store, pathContextMutationInProgress: hasPendingPathContextMutation(theaterId) });
}

function setStore(next: RailStore): void {
  store = next;
  for (const listener of listeners) listener();
}
