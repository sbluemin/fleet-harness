import { useSyncExternalStore } from "react";

export interface OperationGeometry {
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
  readonly operations: Record<string, OperationGeometry>;
  readonly operationOrder: readonly string[];
  readonly operationAccent: Record<string, string>;
  // 최소화된 Operation id 목록. geometry는 operations에 그대로 보존되므로 복원은 원위치·원크기로 되돌린다.
  readonly minimized: readonly string[];
  // 접힌 그룹 id 목록(per-Theater localStorage). 접힘은 시각 표시 상태라 클라이언트 SSoT.
  readonly collapsedGroups: readonly string[];
}

export interface CanvasViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface CanvasWorldRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GridSlotGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type Listener = () => void;

const STORAGE_KEY_PREFIX = "fleet-console.canvas.";
const BACKGROUND_ANIMATION_STORAGE_KEY = "fleet-console.canvas.backgroundAnimation";
const PERIMETER_ANIMATION_STORAGE_KEY = "fleet-console.canvas.perimeterAnimation";
const MAXIMIZED_STORAGE_KEY = "fleet-console.canvas.maximized";
const SAVE_DELAY_MS = 400;
const DEFAULT_OPERATION_WIDTH = 640;
const DEFAULT_OPERATION_HEIGHT = 400;
const DEFAULT_OPERATION_OFFSET = 40;
export const MIN_OPERATION_WIDTH = 320;
export const MIN_OPERATION_HEIGHT = 200;
export const OPERATION_GRID_GAP = 16;
export const OPERATION_GRID_PADDING = 24;
const OPERATION_FOCUS_PADDING = 96;
const FOCUS_MIN_ZOOM = 0.25;
const FOCUS_MAX_ZOOM = 1;
// 줌 보간: 매 프레임 현재 viewport를 target 쪽으로 이 비율만큼 당긴다(지수 감쇠).
const ZOOM_TWEEN_FACTOR = 0.2;
// 이 임계치 미만으로 좁혀지면 target에 스냅하고 보간을 멈춘다(위치 px, 줌 배율).
const ZOOM_TWEEN_POSITION_EPSILON = 0.5;
const ZOOM_TWEEN_ZOOM_EPSILON = 0.001;
const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };
const EMPTY_STATE: CanvasState = { viewport: DEFAULT_VIEWPORT, operations: {}, operationOrder: [], operationAccent: {}, minimized: [], collapsedGroups: [] };

const listeners = new Set<Listener>();
const backgroundAnimationListeners = new Set<Listener>();
const perimeterAnimationListeners = new Set<Listener>();
const mapFullscreenListeners = new Set<Listener>();
const maximizedOperationListeners = new Set<Listener>();
const formationViewListeners = new Set<Listener>();
const maximizedOperationIdsByTheater = new Map<string, string>();
const formationViewsByTheater = new Map<string, true>();
const arrangeSnapshotsByTheater = new Map<string, Record<string, OperationGeometry>>();
let activeTheaterId: string | null = null;
let saveTimer: number | null = null;
let state: CanvasState = EMPTY_STATE;
let backgroundAnimationEnabled = readStoredBackgroundAnimation();
let perimeterAnimationEnabled = readStoredPerimeterAnimation();
let mapFullscreen = readStoredMapFullscreen();
let maximizedOperationId: string | null = null;
let formationView = false;
// 줌 보간 루프가 향하는 목표 viewport. 즉시 이동(pan/focus/load)은 이 값을 current와 동기화해 잔여 보간을 무효화한다.
let targetViewport: CanvasViewport = DEFAULT_VIEWPORT;
let zoomRaf: number | null = null;
// 모든 Operation이 공유하는 단조 증가 z-index 발급기.
// 두 레지스트리가 같은 카운터에서 값을 받아 "활성화한 Operation이 최상단"이 Operation 종류를 가로질러 성립한다.
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

export function getMaximizedOperationId(): string | null {
  return maximizedOperationId;
}

export function getFormationView(): boolean {
  return formationView;
}

export function hasArrangeSnapshot(): boolean {
  return activeTheaterId !== null && arrangeSnapshotsByTheater.has(activeTheaterId);
}

// canvas 스토어가 현재 로드한 Theater id. maximizedOperationId·maximizedOperationIdsByTheater 등
// 최대화 상태는 이 Theater 기준으로 동작하므로, 최대화 관련 가드는 store.activeTheaterId가 아니라 이 값을 기준으로 삼아야 한다.
// (loadForTheater가 passive effect로 갱신되어 store.activeTheaterId보다 한 박자 늦을 수 있다.)
export function getLoadedTheaterId(): string | null {
  return activeTheaterId;
}

export function useCanvasState(): CanvasState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useBackgroundAnimation(): boolean {
  return useSyncExternalStore(subscribeBackgroundAnimation, getBackgroundAnimationSnapshot, getBackgroundAnimationSnapshot);
}

export function usePerimeterAnimation(): boolean {
  return useSyncExternalStore(subscribePerimeterAnimation, getPerimeterAnimationSnapshot, getPerimeterAnimationSnapshot);
}

export function useMapFullscreen(): boolean {
  return useSyncExternalStore(subscribeMapFullscreen, getMapFullscreenSnapshot, getMapFullscreenSnapshot);
}

export function useMaximizedOperationId(): string | null {
  return useSyncExternalStore(subscribeMaximizedOperation, getMaximizedOperationSnapshot, getMaximizedOperationSnapshot);
}

export function useFormationView(): boolean {
  return useSyncExternalStore(subscribeFormationView, getFormationView, getFormationView);
}

// 최소화 목록은 CanvasState의 일부라 메인 listeners/emit을 그대로 공유한다(별도 채널 불필요).
export function useMinimized(): readonly string[] {
  return useSyncExternalStore(subscribe, getMinimizedSnapshot, getMinimizedSnapshot);
}

export function setState(patch: Partial<CanvasState>): void {
  state = {
    viewport: patch.viewport ?? state.viewport,
    operations: patch.operations ?? state.operations,
    operationOrder: patch.operationOrder ?? state.operationOrder,
    operationAccent: patch.operationAccent ?? state.operationAccent,
    minimized: patch.minimized ?? state.minimized,
    collapsedGroups: patch.collapsedGroups ?? state.collapsedGroups,
  };
  scheduleSave();
  emit();
}

export function toggleGroupCollapsed(groupId: string): void {
  const collapsed = state.collapsedGroups.includes(groupId)
    ? state.collapsedGroups.filter((id) => id !== groupId)
    : [...state.collapsedGroups, groupId];
  setState({ collapsedGroups: collapsed });
}

export function useCollapsedGroups(): readonly string[] {
  return useSyncExternalStore(subscribe, getCollapsedGroupsSnapshot, getCollapsedGroupsSnapshot);
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

export function setOperationGeometry(sessionId: string, geometry: OperationGeometry): void {
  const zIndex = claimTopZIndex();
  setState({
    operations: {
      ...state.operations,
      [sessionId]: { ...normalizeOperationGeometry(geometry, zIndex), zIndex },
    },
  });
}

// 화면에서 보이는 캔버스 영역을 world 좌표로 역산한다. canvas.tsx의 translate(x, y) scale(zoom) 순서와
// screenToCanvas 규약을 그대로 반대로 적용하므로 pan/zoom 상태에서도 Arrange 대상 rect가 일치한다.
export function visibleWorldRect(viewport: CanvasViewport, canvasSize: CanvasViewportSize): CanvasWorldRect {
  return {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    width: canvasSize.width / viewport.zoom,
    height: canvasSize.height / viewport.zoom,
  };
}

// 균형 그리드의 열은 ceil(sqrt(n)), 행은 ceil(n / cols)로 정한다. 최소 크기 클램프 뒤에는
// 슬롯이 원래 rect를 넘을 수 있으며, 이는 작은 뷰포트에서도 패널의 조작 가능 크기를 지키기 위한 의도다.
export function calculateGridSlots(
  rect: CanvasWorldRect,
  count: number,
  minimumWidth = MIN_OPERATION_WIDTH,
  minimumHeight = MIN_OPERATION_HEIGHT,
  gap = OPERATION_GRID_GAP,
  padding = OPERATION_GRID_PADDING,
): readonly GridSlotGeometry[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const width = Math.max(minimumWidth, (rect.width - padding * 2 - gap * (columns - 1)) / columns);
  const height = Math.max(minimumHeight, (rect.height - padding * 2 - gap * (rows - 1)) / rows);
  return Array.from({ length: count }, (_, index) => ({
    x: rect.x + padding + (index % columns) * (width + gap),
    y: rect.y + padding + Math.floor(index / columns) * (height + gap),
    width,
    height,
  }));
}

// Arrange는 활성 Theater의 1회성 undo 슬롯을 갱신하고, 기존 zIndex를 그대로 둔 일괄 geometry 쓰기를 한다.
// setOperationGeometry를 반복 호출하면 claimTopZIndex로 stack 순서가 뒤섞이므로 이 경로를 반드시 사용한다.
export function arrangeOperations(operationIds: readonly string[], rect: CanvasWorldRect): readonly string[] {
  const operationIdsToArrange = uniqueExistingOperationIds(operationIds);
  if (operationIdsToArrange.length === 0) return [];
  clearMaximizedOperationId();
  if (activeTheaterId) {
    arrangeSnapshotsByTheater.set(activeTheaterId, Object.fromEntries(operationIdsToArrange.map((id) => [id, state.operations[id]!])));
  }
  const slots = calculateGridSlots(rect, operationIdsToArrange.length);
  const operations = { ...state.operations };
  for (const [index, operationId] of operationIdsToArrange.entries()) {
    const current = operations[operationId]!;
    const slot = slots[index]!;
    operations[operationId] = { ...current, ...slot };
  }
  setState({ operations });
  return operationIdsToArrange;
}

// 한 Theater당 Arrange 직전 geometry만 한 번 보관한다. 닫힌 Operation은 건너뛰고 남아 있는 것만 정확히 복원한다.
export function undoArrange(): readonly string[] {
  if (!activeTheaterId) return [];
  const snapshot = arrangeSnapshotsByTheater.get(activeTheaterId);
  if (!snapshot) return [];
  arrangeSnapshotsByTheater.delete(activeTheaterId);
  const operations = { ...state.operations };
  const restoredIds: string[] = [];
  for (const [operationId, geometry] of Object.entries(snapshot)) {
    if (!operations[operationId]) continue;
    operations[operationId] = geometry;
    restoredIds.push(operationId);
  }
  if (restoredIds.length > 0) setState({ operations });
  return restoredIds;
}

// Operation을 최소화한다 — 캔버스 렌더에서 빠지고 하단 태스크바에 표시된다. geometry는 operations에 보존한다.
export function minimizeOperation(sessionId: string): void {
  if (state.minimized.includes(sessionId)) return;
  if (maximizedOperationId === sessionId) clearMaximizedOperationId();
  setState({ minimized: [...state.minimized, sessionId] });
}

// 최소화한 Operation을 복원한다 — 목록에서 제거하고 보존된 geometry를 최상단 zIndex로 끌어올려 원위치·원크기로 되돌린다.
// 활성화(selectTerminalSession)는 호출 측 책임으로 남겨, Operation 활성 조정을 한 곳(canvas)에서 유지한다.
export function restoreOperation(sessionId: string): void {
  if (!state.minimized.includes(sessionId)) return;
  if (maximizedOperationId === sessionId) clearMaximizedOperationId();
  const minimized = state.minimized.filter((id) => id !== sessionId);
  const geometry = state.operations[sessionId];
  if (!geometry) {
    setState({ minimized });
    return;
  }
  const zIndex = claimTopZIndex();
  setState({
    minimized,
    operations: { ...state.operations, [sessionId]: { ...geometry, zIndex } },
  });
}

// dock 재배치는 항상 "전체 가시 순서"를 통째로 영속한다(canvas-dock의 드래그/키보드 핸들러가 새 순서를 만든다).
export function setOperationOrder(nextOrder: readonly string[]): void {
  setState({ operationOrder: normalizeOperationOrder(nextOrder) });
}

export function setOperationAccent(operationId: string, accentKey: string | null): void {
  const operationAccent = { ...state.operationAccent };
  if (accentKey === null || accentKey.trim() === "") {
    delete operationAccent[operationId];
  } else {
    operationAccent[operationId] = accentKey;
  }
  setState({ operationAccent });
}

export function forgetOperationMetadata(operationId: string): void {
  const operationOrder = state.operationOrder.filter((id) => id !== operationId);
  const orderChanged = operationOrder.length !== state.operationOrder.length;
  const accentChanged = operationId in state.operationAccent;
  if (!orderChanged && !accentChanged) return;
  const operationAccent = { ...state.operationAccent };
  delete operationAccent[operationId];
  setState({ operationOrder, operationAccent });
}

// 공유 z-index 카운터에서 다음 최상단 값을 발급한다. Operation을 활성화·생성할 때 호출한다.
export function claimTopZIndex(): number {
  topZIndex += 1;
  return topZIndex;
}

// 공유 카운터를 주어진 값 이상으로 끌어올린다. Operation 레지스트리가 새로고침 복원 시
// 복원된 셸의 최대 zIndex를 반영해, "활성화→최상단"이 Operations·셸을 가로질러 계속 성립하게 한다.
export function liftTopZIndex(toAtLeast: number): void {
  topZIndex = Math.max(topZIndex, toAtLeast);
}

export function ensureDefaultGeometry(sessionId: string): OperationGeometry {
  const existing = state.operations[sessionId];
  if (existing) return existing;
  const index = Object.keys(state.operations).length;
  const geometry: OperationGeometry = {
    x: index * DEFAULT_OPERATION_OFFSET,
    y: index * DEFAULT_OPERATION_OFFSET,
    width: DEFAULT_OPERATION_WIDTH,
    height: DEFAULT_OPERATION_HEIGHT,
    zIndex: claimTopZIndex(),
  };
  setState({ operations: { ...state.operations, [sessionId]: geometry } });
  return geometry;
}

export function pruneOperations(validSessionIds: readonly string[]): void {
  const valid = new Set(validSessionIds);
  const operations: Record<string, OperationGeometry> = {};
  let changed = false;
  for (const [sessionId, geometry] of Object.entries(state.operations)) {
    if (valid.has(sessionId)) {
      operations[sessionId] = geometry;
    } else {
      changed = true;
    }
  }
  // 사라진 세션은 최소화 목록에서도 함께 제거해 유령 칩이 태스크바에 남지 않게 한다.
  const minimized = state.minimized.filter((sessionId) => valid.has(sessionId));
  const minimizedChanged = minimized.length !== state.minimized.length;
  const operationOrder = state.operationOrder.filter((sessionId) => valid.has(sessionId));
  const orderChanged = operationOrder.length !== state.operationOrder.length;
  const operationAccent = Object.fromEntries(Object.entries(state.operationAccent).filter(([sessionId]) => valid.has(sessionId)));
  const accentChanged = Object.keys(operationAccent).length !== Object.keys(state.operationAccent).length;
  if (maximizedOperationId && (!valid.has(maximizedOperationId) || minimized.includes(maximizedOperationId))) clearMaximizedOperationId();
  if (changed || minimizedChanged || orderChanged || accentChanged) {
    setState({ operations, minimized, operationOrder, operationAccent });
  }
}

export function loadForTheater(theaterId: string | null): void {
  flushScheduledSave();
  cancelZoomTween();
  saveMaximizedOperationForActiveTheater();
  arrangeSnapshotsByTheater.clear();
  activeTheaterId = theaterId;
  state = theaterId ? readStoredState(theaterId) : EMPTY_STATE;
  const nextMaximizedOperationId = theaterId ? maximizedOperationIdsByTheater.get(theaterId) ?? null : null;
  const maximizedChanged = maximizedOperationId !== nextMaximizedOperationId;
  maximizedOperationId = nextMaximizedOperationId;
  const nextFormationView = theaterId ? formationViewsByTheater.has(theaterId) : false;
  const formationChanged = formationView !== nextFormationView;
  formationView = nextFormationView;
  targetViewport = state.viewport;
  // 복원된 Operation의 최대 zIndex 위로 카운터를 끌어올린다 — 새로고침/Theater 전환 후에도 활성화→최상단을 보장한다.
  topZIndex = Math.max(topZIndex, maxZIndexOf(state.operations));
  emit();
  if (maximizedChanged) emitMaximizedOperation();
  if (formationChanged) emitFormationView();
}

export function focusOperation(sessionId: string, viewportSize: CanvasViewportSize): void {
  const geometry = state.operations[sessionId];
  if (!geometry) return;
  const zoom = Math.max(FOCUS_MIN_ZOOM, Math.min(FOCUS_MAX_ZOOM, Math.min(
    (viewportSize.width - OPERATION_FOCUS_PADDING) / geometry.width,
    (viewportSize.height - OPERATION_FOCUS_PADDING) / geometry.height,
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
    operations: {
      ...state.operations,
      [sessionId]: { ...normalizeOperationGeometry(geometry, zIndex), zIndex },
    },
    ...(wasMinimized ? { minimized: state.minimized.filter((id) => id !== sessionId) } : {}),
  });
}

export function toggleBackgroundAnimation(): void {
  backgroundAnimationEnabled = !backgroundAnimationEnabled;
  writeStoredBackgroundAnimation(backgroundAnimationEnabled);
  emitBackgroundAnimation();
}

export function togglePerimeterAnimation(): void {
  perimeterAnimationEnabled = !perimeterAnimationEnabled;
  writeStoredPerimeterAnimation(perimeterAnimationEnabled);
  emitPerimeterAnimation();
}

// local 채널(미게시 pnpm 실행)에서는 ambient 애니메이션(레이더 스윕·패널 펄스)을 기본 끈다.
// 채널은 status로 첫 페인트 이후 도착하므로 모듈 로드 기본값(켜짐) 이후 이 함수로 reconcile한다.
// 사용자가 명시 토글한 선호(localStorage 존재)는 채널과 무관하게 존중하고, 여기서는 localStorage에 쓰지 않아
// '저장된 선호'가 아닌 '기본값'으로만 작동하게 한다(stable 채널의 기존 켜짐 기본값은 불변).
export function applyChannelAnimationDefaults(channel: "stable" | "local" | "unknown"): void {
  if (channel !== "local") return;
  if (backgroundAnimationEnabled && !hasStoredBackgroundAnimation()) {
    backgroundAnimationEnabled = false;
    emitBackgroundAnimation();
  }
  if (perimeterAnimationEnabled && !hasStoredPerimeterAnimation()) {
    perimeterAnimationEnabled = false;
    emitPerimeterAnimation();
  }
}

export function toggleMapFullscreen(): void {
  setMapFullscreen(!mapFullscreen);
}

export function setMapFullscreen(value: boolean): void {
  if (mapFullscreen === value) return;
  mapFullscreen = value;
  writeStoredMapFullscreen(mapFullscreen);
  emitMapFullscreen();
}

export function setMaximizedOperationId(operationId: string): void {
  clearFormationView();
  if (activeTheaterId) maximizedOperationIdsByTheater.set(activeTheaterId, operationId);
  const minimized = minimizedForMaximizedOperation(operationId);
  const minimizedChanged = !stringArraysEqual(state.minimized, minimized);
  const maximizedChanged = maximizedOperationId !== operationId;
  if (maximizedChanged) maximizedOperationId = operationId;
  if (minimizedChanged) setState({ minimized });
  if (maximizedChanged) emitMaximizedOperation();
}

export function clearMaximizedOperationId(): void {
  if (activeTheaterId) maximizedOperationIdsByTheater.delete(activeTheaterId);
  if (maximizedOperationId === null) return;
  maximizedOperationId = null;
  emitMaximizedOperation();
}

export function toggleFormationView(): void {
  if (!activeTheaterId) return;
  if (formationView) {
    clearFormationView();
    return;
  }
  formationViewsByTheater.set(activeTheaterId, true);
  formationView = true;
  clearMaximizedOperationId();
  emitFormationView();
}

export function clearFormationView(): void {
  if (activeTheaterId) formationViewsByTheater.delete(activeTheaterId);
  if (!formationView) return;
  formationView = false;
  emitFormationView();
}

export function subscribeFormationView(listener: Listener): () => void {
  formationViewListeners.add(listener);
  return () => {
    formationViewListeners.delete(listener);
  };
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

function subscribePerimeterAnimation(listener: Listener): () => void {
  perimeterAnimationListeners.add(listener);
  return () => {
    perimeterAnimationListeners.delete(listener);
  };
}

function getPerimeterAnimationSnapshot(): boolean {
  return perimeterAnimationEnabled;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function emitBackgroundAnimation(): void {
  for (const listener of backgroundAnimationListeners) listener();
}

function emitPerimeterAnimation(): void {
  for (const listener of perimeterAnimationListeners) listener();
}

function subscribeMapFullscreen(listener: Listener): () => void {
  mapFullscreenListeners.add(listener);
  return () => {
    mapFullscreenListeners.delete(listener);
  };
}

function getMapFullscreenSnapshot(): boolean {
  return mapFullscreen;
}

function subscribeMaximizedOperation(listener: Listener): () => void {
  maximizedOperationListeners.add(listener);
  return () => {
    maximizedOperationListeners.delete(listener);
  };
}

function getMaximizedOperationSnapshot(): string | null {
  return maximizedOperationId;
}

function emitFormationView(): void {
  for (const listener of formationViewListeners) listener();
}

function getMinimizedSnapshot(): readonly string[] {
  return state.minimized;
}

function getCollapsedGroupsSnapshot(): readonly string[] {
  return state.collapsedGroups;
}

function emitMapFullscreen(): void {
  for (const listener of mapFullscreenListeners) listener();
}

function emitMaximizedOperation(): void {
  for (const listener of maximizedOperationListeners) listener();
}

function saveMaximizedOperationForActiveTheater(): void {
  if (!activeTheaterId) return;
  if (maximizedOperationId) {
    maximizedOperationIdsByTheater.set(activeTheaterId, maximizedOperationId);
  } else {
    maximizedOperationIdsByTheater.delete(activeTheaterId);
  }
}

function minimizedForMaximizedOperation(operationId: string): readonly string[] {
  return Object.keys(state.operations).filter((sessionId) => sessionId !== operationId);
}

function uniqueExistingOperationIds(operationIds: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return operationIds.filter((operationId) => {
    if (seen.has(operationId) || !state.operations[operationId]) return false;
    seen.add(operationId);
    return true;
  });
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function hasStoredBackgroundAnimation(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(BACKGROUND_ANIMATION_STORAGE_KEY) !== null;
  } catch {
    return false;
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

function readStoredPerimeterAnimation(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(PERIMETER_ANIMATION_STORAGE_KEY);
    if (stored === null) return true;
    return stored === "true";
  } catch {
    return true;
  }
}

function hasStoredPerimeterAnimation(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PERIMETER_ANIMATION_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function writeStoredPerimeterAnimation(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PERIMETER_ANIMATION_STORAGE_KEY, String(value));
  } catch {
    // 진행광 애니메이션 선호 저장 실패는 런타임 동작을 막지 않는다.
  }
}

function readStoredMapFullscreen(): boolean {
  // 기본값 false: 저장된 선호가 없으면 GNB를 정상 노출해 첫 방문자가 내비게이션을 잃지 않는다.
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MAXIMIZED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredMapFullscreen(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MAXIMIZED_STORAGE_KEY, String(value));
  } catch {
    // 최대화 선호 저장 실패는 런타임 동작을 막지 않는다.
  }
}

function storageKey(theaterId: string): string {
  return `${STORAGE_KEY_PREFIX}${theaterId}`;
}

function normalizeCanvasState(value: unknown): CanvasState {
  if (!isRecord(value)) return EMPTY_STATE;
  const operations = normalizeOperations(value.operations);
  return {
    viewport: normalizeViewport(value.viewport),
    operations,
    operationOrder: normalizeOperationOrder(value.operationOrder),
    operationAccent: normalizeOperationAccent(value.operationAccent),
    // 저장된 최소화 목록 중 실재하는 Operation만 남긴다(stale 직렬화 방어).
    minimized: normalizeMinimized(value.minimized, operations),
    collapsedGroups: normalizeStringArray(value.collapsedGroups),
  };
}

function normalizeOperationOrder(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const operationOrder: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    operationOrder.push(id);
  }
  return operationOrder;
}

function normalizeOperationAccent(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const operationAccent: Record<string, string> = {};
  for (const [id, accentKey] of Object.entries(value)) {
    if (typeof accentKey !== "string") continue;
    operationAccent[id] = accentKey;
  }
  return operationAccent;
}

function normalizeMinimized(value: unknown, operations: Record<string, OperationGeometry>): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const minimized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || seen.has(entry) || !(entry in operations)) continue;
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

function normalizeOperations(value: unknown): Record<string, OperationGeometry> {
  if (!isRecord(value)) return {};
  const operations: Record<string, OperationGeometry> = {};
  for (const [sessionId, geometry] of Object.entries(value)) {
    if (!isRecord(geometry)) continue;
    operations[sessionId] = normalizeOperationGeometry(geometry, nextZIndexForOperations(operations));
  }
  return operations;
}

function normalizeOperationGeometry(value: unknown, fallbackZIndex: number): OperationGeometry {
  if (!isRecord(value)) {
    return {
      x: 0,
      y: 0,
      width: DEFAULT_OPERATION_WIDTH,
      height: DEFAULT_OPERATION_HEIGHT,
      zIndex: fallbackZIndex,
    };
  }
  return {
    x: readFiniteNumber(value.x, 0),
    y: readFiniteNumber(value.y, 0),
    width: readPositiveNumber(value.width, DEFAULT_OPERATION_WIDTH),
    height: readPositiveNumber(value.height, DEFAULT_OPERATION_HEIGHT),
    zIndex: readFiniteNumber(value.zIndex, fallbackZIndex),
  };
}

function nextZIndexForOperations(operations: Record<string, OperationGeometry>): number {
  return maxZIndexOf(operations) + 1;
}

function maxZIndexOf(operations: Record<string, OperationGeometry>): number {
  return Math.max(0, ...Object.values(operations).map((operation) => operation.zIndex));
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

function normalizeStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}
