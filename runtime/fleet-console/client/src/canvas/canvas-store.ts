import { useSyncExternalStore } from "react";

export interface PanelGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
}

export interface CanvasViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface CanvasState {
  readonly viewport: CanvasViewport;
  readonly panels: Record<string, PanelGeometry>;
}

export interface CanvasViewportSize {
  readonly width: number;
  readonly height: number;
}

type Listener = () => void;

const STORAGE_KEY_PREFIX = "fleet-console.canvas.";
const BACKGROUND_ANIMATION_STORAGE_KEY = "fleet-console.canvas.backgroundAnimation";
const SAVE_DELAY_MS = 400;
const DEFAULT_PANEL_WIDTH = 640;
const DEFAULT_PANEL_HEIGHT = 400;
const DEFAULT_PANEL_OFFSET = 40;
const PANEL_FOCUS_PADDING = 96;
const FOCUS_MIN_ZOOM = 0.25;
const FOCUS_MAX_ZOOM = 1;
const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };
const EMPTY_STATE: CanvasState = { viewport: DEFAULT_VIEWPORT, panels: {} };

const listeners = new Set<Listener>();
const backgroundAnimationListeners = new Set<Listener>();
let activeTheaterId: string | null = null;
let saveTimer: number | null = null;
let state: CanvasState = EMPTY_STATE;
let backgroundAnimationEnabled = readStoredBackgroundAnimation();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): CanvasState {
  return state;
}

export function useCanvasState(): CanvasState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useBackgroundAnimation(): boolean {
  return useSyncExternalStore(subscribeBackgroundAnimation, getBackgroundAnimationSnapshot, getBackgroundAnimationSnapshot);
}

export function setState(patch: Partial<CanvasState>): void {
  state = {
    viewport: patch.viewport ?? state.viewport,
    panels: patch.panels ?? state.panels,
  };
  scheduleSave();
  emit();
}

export function setViewport(viewport: CanvasViewport): void {
  setState({ viewport: normalizeViewport(viewport) });
}

export function setPanelGeometry(sessionId: string, geometry: PanelGeometry): void {
  setState({
    panels: {
      ...state.panels,
      [sessionId]: { ...normalizePanelGeometry(geometry, nextZIndex()), zIndex: nextZIndex() },
    },
  });
}

export function ensureDefaultGeometry(sessionId: string): PanelGeometry {
  const existing = state.panels[sessionId];
  if (existing) return existing;
  const index = Object.keys(state.panels).length;
  const geometry: PanelGeometry = {
    x: index * DEFAULT_PANEL_OFFSET,
    y: index * DEFAULT_PANEL_OFFSET,
    width: DEFAULT_PANEL_WIDTH,
    height: DEFAULT_PANEL_HEIGHT,
    zIndex: nextZIndex(),
  };
  setPanelGeometry(sessionId, geometry);
  return geometry;
}

export function prunePanels(validSessionIds: readonly string[]): void {
  const valid = new Set(validSessionIds);
  const panels: Record<string, PanelGeometry> = {};
  let changed = false;
  for (const [sessionId, geometry] of Object.entries(state.panels)) {
    if (valid.has(sessionId)) {
      panels[sessionId] = geometry;
    } else {
      changed = true;
    }
  }
  if (changed) setState({ panels });
}

export function loadForTheater(theaterId: string | null): void {
  flushScheduledSave();
  activeTheaterId = theaterId;
  state = theaterId ? readStoredState(theaterId) : EMPTY_STATE;
  emit();
}

export function focusPanel(sessionId: string, viewportSize: CanvasViewportSize): void {
  const geometry = state.panels[sessionId];
  if (!geometry) return;
  const zoom = Math.max(FOCUS_MIN_ZOOM, Math.min(FOCUS_MAX_ZOOM, Math.min(
    (viewportSize.width - PANEL_FOCUS_PADDING) / geometry.width,
    (viewportSize.height - PANEL_FOCUS_PADDING) / geometry.height,
  )));
  setState({
    viewport: {
      x: viewportSize.width / 2 - (geometry.x + geometry.width / 2) * zoom,
      y: viewportSize.height / 2 - (geometry.y + geometry.height / 2) * zoom,
      zoom,
    },
    panels: {
      ...state.panels,
      [sessionId]: { ...normalizePanelGeometry(geometry, nextZIndex()), zIndex: nextZIndex() },
    },
  });
}

export function toggleBackgroundAnimation(): void {
  backgroundAnimationEnabled = !backgroundAnimationEnabled;
  writeStoredBackgroundAnimation(backgroundAnimationEnabled);
  emitBackgroundAnimation();
}

function subscribeBackgroundAnimation(listener: Listener): () => void {
  backgroundAnimationListeners.add(listener);
  return () => {
    backgroundAnimationListeners.delete(listener);
  };
}

function getBackgroundAnimationSnapshot(): boolean {
  return backgroundAnimationEnabled;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function emitBackgroundAnimation(): void {
  for (const listener of backgroundAnimationListeners) listener();
}

function scheduleSave(): void {
  if (!activeTheaterId || typeof window === "undefined") return;
  cancelScheduledSave();
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    writeStoredState(activeTheaterId, state);
  }, SAVE_DELAY_MS);
}

function flushScheduledSave(): void {
  if (!saveTimer || !activeTheaterId || typeof window === "undefined") return;
  window.clearTimeout(saveTimer);
  saveTimer = null;
  writeStoredState(activeTheaterId, state);
}

function cancelScheduledSave(): void {
  if (!saveTimer || typeof window === "undefined") return;
  window.clearTimeout(saveTimer);
  saveTimer = null;
}

function readStoredState(theaterId: string): CanvasState {
  if (typeof window === "undefined") return EMPTY_STATE;
  try {
    const stored = window.localStorage.getItem(storageKey(theaterId));
    if (!stored) return EMPTY_STATE;
    const parsed: unknown = JSON.parse(stored);
    return normalizeCanvasState(parsed);
  } catch {
    return EMPTY_STATE;
  }
}

function writeStoredState(theaterId: string | null, value: CanvasState): void {
  if (!theaterId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(theaterId), JSON.stringify(value));
  } catch {
    // 저장 실패는 캔버스 복구성만 낮추므로 런타임 흐름을 막지 않는다.
  }
}

function readStoredBackgroundAnimation(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(BACKGROUND_ANIMATION_STORAGE_KEY);
    if (stored === null) return true;
    return stored === "true";
  } catch {
    return true;
  }
}

function writeStoredBackgroundAnimation(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BACKGROUND_ANIMATION_STORAGE_KEY, String(value));
  } catch {
    // 배경 애니메이션 선호 저장 실패는 런타임 동작을 막지 않는다.
  }
}

function storageKey(theaterId: string): string {
  return `${STORAGE_KEY_PREFIX}${theaterId}`;
}

function normalizeCanvasState(value: unknown): CanvasState {
  if (!isRecord(value)) return EMPTY_STATE;
  return {
    viewport: normalizeViewport(value.viewport),
    panels: normalizePanels(value.panels),
  };
}

function normalizeViewport(value: unknown): CanvasViewport {
  if (!isRecord(value)) return DEFAULT_VIEWPORT;
  const x = readFiniteNumber(value.x, DEFAULT_VIEWPORT.x);
  const y = readFiniteNumber(value.y, DEFAULT_VIEWPORT.y);
  const zoom = readPositiveNumber(value.zoom, DEFAULT_VIEWPORT.zoom);
  return { x, y, zoom };
}

function normalizePanels(value: unknown): Record<string, PanelGeometry> {
  if (!isRecord(value)) return {};
  const panels: Record<string, PanelGeometry> = {};
  for (const [sessionId, geometry] of Object.entries(value)) {
    if (!isRecord(geometry)) continue;
    panels[sessionId] = normalizePanelGeometry(geometry, nextZIndexForPanels(panels));
  }
  return panels;
}

function normalizePanelGeometry(value: unknown, fallbackZIndex: number): PanelGeometry {
  if (!isRecord(value)) {
    return {
      x: 0,
      y: 0,
      width: DEFAULT_PANEL_WIDTH,
      height: DEFAULT_PANEL_HEIGHT,
      zIndex: fallbackZIndex,
    };
  }
  return {
    x: readFiniteNumber(value.x, 0),
    y: readFiniteNumber(value.y, 0),
    width: readPositiveNumber(value.width, DEFAULT_PANEL_WIDTH),
    height: readPositiveNumber(value.height, DEFAULT_PANEL_HEIGHT),
    zIndex: readFiniteNumber(value.zIndex, fallbackZIndex),
  };
}

function nextZIndex(): number {
  return nextZIndexForPanels(state.panels);
}

function nextZIndexForPanels(panels: Record<string, PanelGeometry>): number {
  return Math.max(0, ...Object.values(panels).map((panel) => panel.zIndex)) + 1;
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
