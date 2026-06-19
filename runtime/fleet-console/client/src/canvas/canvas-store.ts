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
  // 최소화된 Operation sessionId 목록. geometry는 panels에 그대로 보존되므로 복원은 원위치·원크기로 되돌린다.
  readonly minimized: readonly string[];
}

export interface CanvasViewportSize {
  readonly width: number;
  readonly height: number;
}

type Listener = () => void;

const STORAGE_KEY_PREFIX = "fleet-console.canvas.";
const BACKGROUND_ANIMATION_STORAGE_KEY = "fleet-console.canvas.backgroundAnimation";
const MAXIMIZED_STORAGE_KEY = "fleet-console.canvas.maximized";
const DOCK_EXPANDED_STORAGE_KEY = "fleet-console.canvas.dockExpanded";
const SAVE_DELAY_MS = 400;
const DEFAULT_PANEL_WIDTH = 640;
const DEFAULT_PANEL_HEIGHT = 400;
const DEFAULT_PANEL_OFFSET = 40;
const PANEL_FOCUS_PADDING = 96;
const FOCUS_MIN_ZOOM = 0.25;
const FOCUS_MAX_ZOOM = 1;
// 줌 보간: 매 프레임 현재 viewport를 target 쪽으로 이 비율만큼 당긴다(지수 감쇠).
const ZOOM_TWEEN_FACTOR = 0.2;
// 이 임계치 미만으로 좁혀지면 target에 스냅하고 보간을 멈춘다(위치 px, 줌 배율).
const ZOOM_TWEEN_POSITION_EPSILON = 0.5;
const ZOOM_TWEEN_ZOOM_EPSILON = 0.001;
const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };
const EMPTY_STATE: CanvasState = { viewport: DEFAULT_VIEWPORT, panels: {}, minimized: [] };

const listeners = new Set<Listener>();
const backgroundAnimationListeners = new Set<Listener>();
const maximizedListeners = new Set<Listener>();
const dockExpandedListeners = new Set<Listener>();
let activeTheaterId: string | null = null;
let saveTimer: number | null = null;
let state: CanvasState = EMPTY_STATE;
let backgroundAnimationEnabled = readStoredBackgroundAnimation();
let maximized = readStoredMaximized();
let dockExpanded = readStoredDockExpanded();
// 줌 보간 루프가 향하는 목표 viewport. 즉시 이동(pan/focus/load)은 이 값을 current와 동기화해 잔여 보간을 무효화한다.
let targetViewport: CanvasViewport = DEFAULT_VIEWPORT;
let zoomRaf: number | null = null;
// 모든 패널(Operations + 셸)이 공유하는 단조 증가 z-index 발급기.
// 두 레지스트리가 같은 카운터에서 값을 받아 "활성화한 패널이 최상단"이 패널 종류를 가로질러 성립한다.
let topZIndex = 0;

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

export function useMaximized(): boolean {
  return useSyncExternalStore(subscribeMaximized, getMaximizedSnapshot, getMaximizedSnapshot);
}

// 최소화 목록은 CanvasState의 일부라 메인 listeners/emit을 그대로 공유한다(별도 채널 불필요).
export function useMinimized(): readonly string[] {
  return useSyncExternalStore(subscribe, getMinimizedSnapshot, getMinimizedSnapshot);
}

// 하단 Dock(최소화 패널 트레이)의 펼침/접힘 — 브라우저별 UI 선호라 maximized와 같은 패턴으로 영속한다.
export function useDockExpanded(): boolean {
  return useSyncExternalStore(subscribeDockExpanded, getDockExpandedSnapshot, getDockExpandedSnapshot);
}

export function setState(patch: Partial<CanvasState>): void {
  state = {
    viewport: patch.viewport ?? state.viewport,
    panels: patch.panels ?? state.panels,
    minimized: patch.minimized ?? state.minimized,
  };
  scheduleSave();
  emit();
}

// 즉시 이동(pan 드래그·검색 이동 등). 진행 중 줌 보간을 취소하고 current·target을 같은 값으로 맞춘다.
export function setViewport(viewport: CanvasViewport): void {
  cancelZoomTween();
  const next = normalizeViewport(viewport);
  targetViewport = next;
  setState({ viewport: next });
}

// 보간 이동(휠 줌). target만 갱신하고 rAF 루프가 current를 target으로 부드럽게 당긴다.
// prefers-reduced-motion이거나 rAF를 못 쓰면 즉시 적용한다.
export function animateViewportTo(viewport: CanvasViewport): void {
  const next = normalizeViewport(viewport);
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function" || prefersReducedMotion()) {
    setViewport(next);
    return;
  }
  targetViewport = next;
  if (zoomRaf === null) zoomRaf = window.requestAnimationFrame(stepZoomTween);
}

export function setPanelGeometry(sessionId: string, geometry: PanelGeometry): void {
  const zIndex = claimTopZIndex();
  setState({
    panels: {
      ...state.panels,
      [sessionId]: { ...normalizePanelGeometry(geometry, zIndex), zIndex },
    },
  });
}

// 패널을 최소화한다 — 캔버스 렌더에서 빠지고 하단 태스크바에 표시된다. geometry는 panels에 보존한다.
export function minimizePanel(sessionId: string): void {
  if (state.minimized.includes(sessionId)) return;
  setState({ minimized: [...state.minimized, sessionId] });
}

// 최소화한 패널을 복원한다 — 목록에서 제거하고 보존된 geometry를 최상단 zIndex로 끌어올려 원위치·원크기로 되돌린다.
// 활성화(selectTerminalSession)는 호출 측 책임으로 남겨, 셸/Operations 상호배타 조정을 한 곳(canvas)에서 유지한다.
export function restorePanel(sessionId: string): void {
  if (!state.minimized.includes(sessionId)) return;
  const minimized = state.minimized.filter((id) => id !== sessionId);
  const geometry = state.panels[sessionId];
  if (!geometry) {
    setState({ minimized });
    return;
  }
  const zIndex = claimTopZIndex();
  setState({
    minimized,
    panels: { ...state.panels, [sessionId]: { ...geometry, zIndex } },
  });
}

// 공유 z-index 카운터에서 다음 최상단 값을 발급한다(Operations·셸 공통). 패널을 활성화·생성할 때 호출한다.
export function claimTopZIndex(): number {
  topZIndex += 1;
  return topZIndex;
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
    zIndex: claimTopZIndex(),
  };
  setState({ panels: { ...state.panels, [sessionId]: geometry } });
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
  // 사라진 세션은 최소화 목록에서도 함께 제거해 유령 칩이 태스크바에 남지 않게 한다.
  const minimized = state.minimized.filter((sessionId) => valid.has(sessionId));
  const minimizedChanged = minimized.length !== state.minimized.length;
  if (changed || minimizedChanged) setState({ panels, minimized });
}

export function loadForTheater(theaterId: string | null): void {
  flushScheduledSave();
  cancelZoomTween();
  activeTheaterId = theaterId;
  state = theaterId ? readStoredState(theaterId) : EMPTY_STATE;
  targetViewport = state.viewport;
  // 복원된 패널의 최대 zIndex 위로 카운터를 끌어올린다 — 새로고침/Theater 전환 후에도 활성화→최상단을 보장한다.
  topZIndex = Math.max(topZIndex, maxZIndexOf(state.panels));
  emit();
}

export function focusPanel(sessionId: string, viewportSize: CanvasViewportSize): void {
  const geometry = state.panels[sessionId];
  if (!geometry) return;
  const zoom = Math.max(FOCUS_MIN_ZOOM, Math.min(FOCUS_MAX_ZOOM, Math.min(
    (viewportSize.width - PANEL_FOCUS_PADDING) / geometry.width,
    (viewportSize.height - PANEL_FOCUS_PADDING) / geometry.height,
  )));
  const focusedViewport: CanvasViewport = {
    x: viewportSize.width / 2 - (geometry.x + geometry.width / 2) * zoom,
    y: viewportSize.height / 2 - (geometry.y + geometry.height / 2) * zoom,
    zoom,
  };
  // 진행 중 줌 보간을 취소하고 target을 포커스 결과로 맞춰, 마지막 tween 프레임이 포커스를 되돌리지 못하게 한다.
  cancelZoomTween();
  targetViewport = focusedViewport;
  const zIndex = claimTopZIndex();
  // 포커스(사이드바·검색 점프·Alt+화살표)는 최소화 상태도 함께 해제한다 — 안 그러면 "포커스했는데 안 보임"이 된다.
  const wasMinimized = state.minimized.includes(sessionId);
  setState({
    viewport: focusedViewport,
    panels: {
      ...state.panels,
      [sessionId]: { ...normalizePanelGeometry(geometry, zIndex), zIndex },
    },
    ...(wasMinimized ? { minimized: state.minimized.filter((id) => id !== sessionId) } : {}),
  });
}

export function toggleBackgroundAnimation(): void {
  backgroundAnimationEnabled = !backgroundAnimationEnabled;
  writeStoredBackgroundAnimation(backgroundAnimationEnabled);
  emitBackgroundAnimation();
}

export function toggleMaximized(): void {
  setMaximized(!maximized);
}

export function setMaximized(value: boolean): void {
  if (maximized === value) return;
  maximized = value;
  writeStoredMaximized(maximized);
  emitMaximized();
}

export function toggleDockExpanded(): void {
  dockExpanded = !dockExpanded;
  writeStoredDockExpanded(dockExpanded);
  emitDockExpanded();
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

function subscribeMaximized(listener: Listener): () => void {
  maximizedListeners.add(listener);
  return () => {
    maximizedListeners.delete(listener);
  };
}

function getMaximizedSnapshot(): boolean {
  return maximized;
}

function getMinimizedSnapshot(): readonly string[] {
  return state.minimized;
}

function emitMaximized(): void {
  for (const listener of maximizedListeners) listener();
}

function subscribeDockExpanded(listener: Listener): () => void {
  dockExpandedListeners.add(listener);
  return () => {
    dockExpandedListeners.delete(listener);
  };
}

function getDockExpandedSnapshot(): boolean {
  return dockExpanded;
}

function emitDockExpanded(): void {
  for (const listener of dockExpandedListeners) listener();
}

// 줌 보간 한 프레임: current를 target 쪽으로 ZOOM_TWEEN_FACTOR만큼 당기고, 임계치 안이면 스냅 후 정지한다.
function stepZoomTween(): void {
  const current = state.viewport;
  const dx = targetViewport.x - current.x;
  const dy = targetViewport.y - current.y;
  const dz = targetViewport.zoom - current.zoom;
  if (Math.abs(dx) < ZOOM_TWEEN_POSITION_EPSILON && Math.abs(dy) < ZOOM_TWEEN_POSITION_EPSILON && Math.abs(dz) < ZOOM_TWEEN_ZOOM_EPSILON) {
    zoomRaf = null;
    setState({ viewport: targetViewport });
    return;
  }
  setState({
    viewport: {
      x: current.x + dx * ZOOM_TWEEN_FACTOR,
      y: current.y + dy * ZOOM_TWEEN_FACTOR,
      zoom: current.zoom + dz * ZOOM_TWEEN_FACTOR,
    },
  });
  zoomRaf = typeof window !== "undefined" ? window.requestAnimationFrame(stepZoomTween) : null;
}

function cancelZoomTween(): void {
  if (zoomRaf === null || typeof window === "undefined") return;
  window.cancelAnimationFrame(zoomRaf);
  zoomRaf = null;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

function readStoredMaximized(): boolean {
  // 기본값 false: 저장된 선호가 없으면 GNB를 정상 노출해 첫 방문자가 내비게이션을 잃지 않는다.
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MAXIMIZED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredMaximized(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MAXIMIZED_STORAGE_KEY, String(value));
  } catch {
    // 최대화 선호 저장 실패는 런타임 동작을 막지 않는다.
  }
}

function readStoredDockExpanded(): boolean {
  // 기본값 true: 패널을 처음 최소화하면 곧바로 칩이 보이도록 펼친 상태로 시작한다.
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(DOCK_EXPANDED_STORAGE_KEY);
    if (stored === null) return true;
    return stored === "true";
  } catch {
    return true;
  }
}

function writeStoredDockExpanded(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DOCK_EXPANDED_STORAGE_KEY, String(value));
  } catch {
    // Dock 펼침 선호 저장 실패는 런타임 동작을 막지 않는다.
  }
}

function storageKey(theaterId: string): string {
  return `${STORAGE_KEY_PREFIX}${theaterId}`;
}

function normalizeCanvasState(value: unknown): CanvasState {
  if (!isRecord(value)) return EMPTY_STATE;
  const panels = normalizePanels(value.panels);
  return {
    viewport: normalizeViewport(value.viewport),
    panels,
    // 저장된 최소화 목록 중 실재하는 패널만 남긴다(stale 직렬화 방어).
    minimized: normalizeMinimized(value.minimized, panels),
  };
}

function normalizeMinimized(value: unknown, panels: Record<string, PanelGeometry>): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const minimized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || seen.has(entry) || !(entry in panels)) continue;
    seen.add(entry);
    minimized.push(entry);
  }
  return minimized;
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

function nextZIndexForPanels(panels: Record<string, PanelGeometry>): number {
  return maxZIndexOf(panels) + 1;
}

function maxZIndexOf(panels: Record<string, PanelGeometry>): number {
  return Math.max(0, ...Object.values(panels).map((panel) => panel.zIndex));
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
