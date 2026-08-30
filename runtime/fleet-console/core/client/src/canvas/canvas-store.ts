import { useSyncExternalStore } from "react";

import { readCanvasModeSession, rememberFormationTheaters } from "./canvas-mode-session.js";


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
  // Station Keeping — Cruise의 상시 비겹침 규율(옵트인, Theater별). 켜는 순간 한 번 펼치고,
  // 켜져 있는 동안 생성·이동·리사이즈·복원이 정착을 거친다. 끄는 것은 좌표를 되돌리지 않는다.
  readonly stationKeeping: boolean;
}

export interface CanvasViewportSize {
  readonly width: number;
  readonly height: number;
}

/* 전면(full-bleed) 캔버스 위에 뜬 크롬(부유 사이드바·레일 카드)이 가리는 가장자리 폭.
   캔버스 박스에서 이 인셋을 뺀 사각형이 "아레나" — 사용자가 실제로 보는 유효 뷰포트다.
   월드 변환은 아레나 원점에 앵커되므로(canvas.tsx) 저장된 viewport/geometry는 계속
   아레나-상대 좌표다. fit-all·focus·모드 슬롯·미니맵은 전부 아레나 크기로 계산해야
   패널이 부유 크롬 밑으로 배치되지 않는다(전면화 리스크 감사 계약). */
export interface CanvasArenaInsets {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
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

export type FormationLayout = "grid" | "columns" | "rows";

type Listener = () => void;
export type FocusLayerState =
  | { readonly mode: "maximized"; readonly operationId: string }
  | { readonly mode: "companion"; readonly operationId: string; readonly returnTo: "underlay" | "maximized" };
type CompanionPanelVisibilityOverrides = Record<string, Readonly<Record<string, boolean>>>;

const STORAGE_KEY_PREFIX = "fleet-console.canvas.";
const FORMATION_LAYOUT_STORAGE_KEY = "fleet-console.formation-layout";
const SAVE_DELAY_MS = 400;
const DEFAULT_OPERATION_WIDTH = 640;
const DEFAULT_OPERATION_HEIGHT = 400;
const DEFAULT_OPERATION_OFFSET = 40;
export const MIN_OPERATION_WIDTH = 320;
export const MIN_OPERATION_HEIGHT = 200;
const OPERATION_GRID_GAP = 8;
const OPERATION_GRID_PADDING = 0;
// 본문 위에 붙는 창 캡션 높이. CSS top:-32px / height:32px 와 한 값이다.
// grid/rows 행 보폭에 넣어 아래 행 캡션이 위 행 본문을 침범하지 않게 한다.
export const OPERATION_WINDOW_CAPTION_HEIGHT = 32;
const OPERATION_FOCUS_PADDING = 96;
const FOCUS_MIN_ZOOM = 0.25;
// fit-all의 하한은 사용성 경계가 아니라 수치 안전 epsilon이다 — fit은 "전체를 담는" 계약이라
// 임의의 사용성 하한(0.25, 0.1 등)은 초광폭 배치에서 가장자리 클리핑으로 계약을 깬다.
const FIT_ALL_MIN_ZOOM = 0.02;
const FOCUS_MAX_ZOOM = 1;
// 줌 보간: 매 프레임 현재 viewport를 target 쪽으로 이 비율만큼 당긴다(지수 감쇠).
const ZOOM_TWEEN_FACTOR = 0.2;
// 이 임계치 미만으로 좁혀지면 target에 스냅하고 보간을 멈춘다(위치 px, 줌 배율).
const ZOOM_TWEEN_POSITION_EPSILON = 0.5;
const ZOOM_TWEEN_ZOOM_EPSILON = 0.001;
const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };
const EMPTY_STATE: CanvasState = { viewport: DEFAULT_VIEWPORT, operations: {}, operationOrder: [], operationAccent: {}, minimized: [], collapsedGroups: [], stationKeeping: false };
// Station Keeping이 유지하는 패널 사이 최소 간격(월드 단위). 줌과 무관하게 월드 좌표로만 계산한다.
// 충돌 상자는 본문이 아니라 창 캡션(top:-32px)을 더한 시각 프레임이다.
export const STATION_KEEPING_GAP = 16;

const listeners = new Set<Listener>();
const focusLayerListeners = new Set<Listener>();
const companionPanelVisibilityListeners = new Set<Listener>();
const formationViewListeners = new Set<Listener>();
const formationLayoutListeners = new Set<Listener>();
const focusLayersByTheater = new Map<string, FocusLayerState>();
// 탭 세션에 남아 있던 Tactical Theater 목록으로 시작한다 — 콘솔 전환·새로고침으로 모듈 메모리가
// 사라져도 Tactical로 보던 Theater가 Cruise로 떨어지지 않게 한다(canvas-mode-session).
const formationViewsByTheater = new Map<string, true>(
  readCanvasModeSession().formationTheaters.map((theaterId) => [theaterId, true] as const),
);
let activeTheaterId: string | null = null;
let saveTimer: number | null = null;
let state: CanvasState = EMPTY_STATE;
let focusLayer: FocusLayerState | null = null;
let focusLayerRevision = 0;
let companionPanelVisibilityOverrides: CompanionPanelVisibilityOverrides = {};
let formationView = false;
let formationLayout = readStoredFormationLayout();
let canvasViewportSize: CanvasViewportSize = { width: 0, height: 0 };
let fitAllOperationsPending = false;
// 줌 보간 루프가 향하는 목표 viewport. 즉시 이동(pan/focus/load)은 이 값을 current와 동기화해 잔여 보간을 무효화한다.
let targetViewport: CanvasViewport = DEFAULT_VIEWPORT;
let zoomRaf: number | null = null;
let beforeFormationViewActivation: ((theaterId: string) => void) | null = null;
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

// 비활성 Theater의 사이드바는 현재 캔버스를 전환하지 않고, 해당 Theater에 저장된 표시 상태만 읽는다.
export function getTheaterCanvasSnapshot(theaterId: string): CanvasState {
  return activeTheaterId === theaterId ? state : readStoredState(theaterId);
}

export function getMaximizedOperationId(): string | null {
  return focusLayer?.mode === "maximized" ? focusLayer.operationId : null;
}

export function getCompanionOperationId(): string | null {
  return focusLayer?.mode === "companion" ? focusLayer.operationId : null;
}

export function getFocusLayerRevision(): number {
  return focusLayerRevision;
}

export function getTheaterCompanionOperationId(theaterId: string): string | null {
  const layer = activeTheaterId === theaterId ? focusLayer : focusLayersByTheater.get(theaterId) ?? null;
  return layer?.mode === "companion" ? layer.operationId : null;
}

export function getTheaterFocusLayerSnapshot(theaterId: string): FocusLayerState | null {
  return activeTheaterId === theaterId ? focusLayer : focusLayersByTheater.get(theaterId) ?? null;
}

export function setTheaterFocusLayerSnapshot(theaterId: string, nextFocusLayer: FocusLayerState | null): void {
  if (nextFocusLayer) focusLayersByTheater.set(theaterId, nextFocusLayer);
  else focusLayersByTheater.delete(theaterId);
  if (activeTheaterId !== theaterId || focusLayersEqual(focusLayer, nextFocusLayer)) return;
  focusLayer = nextFocusLayer;
  emitFocusLayer();
}

export function getFormationView(): boolean {
  return formationView;
}

export function getFormationLayout(): FormationLayout {
  return formationLayout;
}

// canvas 스토어가 현재 로드한 Theater id. focus layer와 Formation 상태는 이 Theater 기준으로
// 동작하므로 관련 가드는 store.activeTheaterId가 아니라 이 값을 기준으로 삼아야 한다.
// (loadForTheater가 passive effect로 갱신되어 store.activeTheaterId보다 한 박자 늦을 수 있다.)
export function getLoadedTheaterId(): string | null {
  return activeTheaterId;
}

export function useCanvasState(): CanvasState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useMaximizedOperationId(): string | null {
  return useSyncExternalStore(subscribeFocusLayer, getMaximizedOperationId, getMaximizedOperationId);
}

export function useCompanionOperationId(): string | null {
  return useSyncExternalStore(subscribeFocusLayer, getCompanionOperationId, getCompanionOperationId);
}

export function getCompanionPanelVisibilityOverrides(operationId: string): Readonly<Record<string, boolean>> {
  return companionPanelVisibilityOverrides[operationId] ?? {};
}

export function useCompanionPanelVisibilityOverrides(operationId: string | null): Readonly<Record<string, boolean>> {
  const snapshot = useSyncExternalStore(subscribeCompanionPanelVisibility, getCompanionPanelVisibilitySnapshot, getCompanionPanelVisibilitySnapshot);
  return operationId === null ? {} : snapshot[operationId] ?? {};
}

export function setCompanionPanelVisible(operationId: string, companionPanelId: string, visible: boolean): void {
  const current = companionPanelVisibilityOverrides[operationId] ?? {};
  if (current[companionPanelId] === visible) return;
  companionPanelVisibilityOverrides = {
    ...companionPanelVisibilityOverrides,
    [operationId]: { ...current, [companionPanelId]: visible },
  };
  emitCompanionPanelVisibility();
}

export function useFormationView(): boolean {
  return useSyncExternalStore(subscribeFormationView, getFormationView, getFormationView);
}

export function useFormationLayout(): FormationLayout {
  return useSyncExternalStore(subscribeFormationLayout, getFormationLayout, getFormationLayout);
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
    stationKeeping: patch.stationKeeping ?? state.stationKeeping,
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

// 비활성 Theater의 그룹 접힘은 해당 Theater 저장소에만 즉시 반영한다. 현재 캔버스 전환이나 다른
// Theater의 저장 예약에는 관여하지 않아, 사이드바 표시 조작이 잘못된 캔버스를 바꾸지 않게 한다.
export function toggleTheaterGroupCollapsed(theaterId: string, groupId: string): void {
  if (activeTheaterId === theaterId) {
    toggleGroupCollapsed(groupId);
    return;
  }
  const theaterState = readStoredState(theaterId);
  const collapsedGroups = theaterState.collapsedGroups.includes(groupId)
    ? theaterState.collapsedGroups.filter((id) => id !== groupId)
    : [...theaterState.collapsedGroups, groupId];
  writeStoredState(theaterId, { ...theaterState, collapsedGroups });
  // 현재 Theater 값은 바꾸지 않되 구독 컴포넌트가 비활성 Theater 스냅샷을 다시 읽게 한다.
  state = { ...state };
  emit();
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

export function setCanvasViewportSize(viewportSize: CanvasViewportSize): void {
  canvasViewportSize = viewportSize;
}

// 아레나 인셋은 Operations 페이지(크롬 구성의 소유자)가 사이드바/레일 상태에서 계산해 심는다.
// 스토어는 fit-all의 분모·중심 계산에서만 소비한다 — 알림 없는 모듈 값(뷰포트 크기와 동일 계약).
let canvasArenaInsets: CanvasArenaInsets = { left: 0, top: 0, right: 0, bottom: 0 };

export function setCanvasArenaInsets(insets: CanvasArenaInsets): void {
  canvasArenaInsets = insets;
}

export function getCanvasArenaInsets(): CanvasArenaInsets {
  return canvasArenaInsets;
}

export function requestFitAllOperations(): void {
  fitAllOperationsPending = true;
  consumePendingFitAllOperations();
}

export function consumePendingFitAllOperations(): void {
  if (!fitAllOperationsPending || canvasViewportSize.width <= 0 || canvasViewportSize.height <= 0) return;
  fitAllOperationsPending = false;
  fitAllOperations();
}

export function resetCanvasViewportSize(): void {
  canvasViewportSize = { width: 0, height: 0 };
  fitAllOperationsPending = false;
}

export function fitAllOperations(): void {
  if (formationView || focusLayer !== null || canvasViewportSize.width <= 0 || canvasViewportSize.height <= 0) return;
  // 분모와 중심은 캔버스 박스가 아니라 아레나다 — 전면 캔버스에서 박스 크기로 맞추면
  // 가장자리 패널이 부유 크롬 밑에 착지하고 그 중심이 viewport로 영속된다.
  const arenaWidth = Math.max(1, canvasViewportSize.width - canvasArenaInsets.left - canvasArenaInsets.right);
  const arenaHeight = Math.max(1, canvasViewportSize.height - canvasArenaInsets.top - canvasArenaInsets.bottom);
  const minimized = new Set(state.minimized);
  const visibleGeometries = Object.entries(state.operations)
    .filter(([operationId]) => !minimized.has(operationId))
    .map(([, geometry]) => geometry);
  if (visibleGeometries.length === 0) return;
  const minX = Math.min(...visibleGeometries.map((geometry) => geometry.x));
  const minY = Math.min(...visibleGeometries.map((geometry) => geometry.y));
  const maxX = Math.max(...visibleGeometries.map((geometry) => geometry.x + geometry.width));
  const maxY = Math.max(...visibleGeometries.map((geometry) => geometry.y + geometry.height));
  const bboxWidth = maxX - minX;
  const bboxHeight = maxY - minY;
  const zoom = Math.max(FIT_ALL_MIN_ZOOM, Math.min(FOCUS_MAX_ZOOM, Math.min(
    (arenaWidth - OPERATION_FOCUS_PADDING) / bboxWidth,
    (arenaHeight - OPERATION_FOCUS_PADDING) / bboxHeight,
  )));
  animateViewportTo({
    x: arenaWidth / 2 - (minX + bboxWidth / 2) * zoom,
    y: arenaHeight / 2 - (minY + bboxHeight / 2) * zoom,
    zoom,
  });
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

// 비활성 Theater의 패널 좌표까지 바꿀 수 있는 경로 — War Room 지도는 전 Theater를 한 판에
// 올리므로 지금 열려 있지 않은 Theater의 패널도 옮겨진다. 활성 Theater면 평소 경로 그대로다.
// z 순서는 건드리지 않는다: 보이지도 않는 Theater의 패널이 좌표만 바뀌었다고 맨 앞으로 올라올
// 이유가 없고, 지도에는 z가 없어 사용자가 그 결과를 볼 수도 없다.
export function setTheaterOperationGeometry(
  theaterId: string,
  sessionId: string,
  geometry: OperationGeometry,
): void {
  if (activeTheaterId === theaterId) {
    setOperationGeometry(sessionId, geometry);
    return;
  }
  const theaterState = readStoredState(theaterId);
  const zIndex = theaterState.operations[sessionId]?.zIndex ?? 1;
  writeStoredState(theaterId, {
    ...theaterState,
    operations: {
      ...theaterState.operations,
      [sessionId]: { ...normalizeOperationGeometry(geometry, zIndex), zIndex },
    },
  });
  // 현재 Theater 값은 그대로 두되 구독 컴포넌트가 비활성 Theater 스냅샷을 다시 읽게 한다.
  state = { ...state };
  emit();
}

// 최소화도 좌표와 같은 이유로 비활성 Theater까지 닿아야 한다 — War Room의 deck과 사이드바는 전
// Theater를 한 판에 올리므로, 지금 열려 있지 않은 Theater의 패널도 그 자리에서 내리고 되올린다.
// 활성 Theater면 geometry 보존·zIndex 복원을 그대로 지는 평소 경로로 넘긴다.
export function setTheaterOperationMinimized(theaterId: string, sessionId: string, minimized: boolean): void {
  if (activeTheaterId === theaterId) {
    if (minimized) minimizeOperation(sessionId);
    else restoreOperation(sessionId);
    return;
  }
  const theaterState = readStoredState(theaterId);
  if (theaterState.minimized.includes(sessionId) === minimized) return;
  // 활성 경로(minimizeOperation)가 지는 focus layer 정리를 여기서도 한다 — War Room 무대에는 다른
  // Theater의 Operation도 서고 그 위에 최대화·동반 레이어가 붙으므로, 건너뛰면 무대에서 내린 패널의
  // 레이어가 그대로 남는다. 레이어는 Operation의 Theater가 아니라 로드된 Theater 키로 저장되므로
  // (setFocusLayer) 여기서도 그 Theater가 아니라 지금 켜진 레이어를 본다.
  if (minimized) {
    if (getMaximizedOperationId() === sessionId) clearMaximizedOperationId();
    if (getCompanionOperationId() === sessionId) forceDropCompanionOperationId();
  }
  // 되올릴 때는 활성 경로(restoreOperation)처럼 맨 앞으로 끌어올린다 — 그 Theater를 열었을 때 방금
  // 되올린 패널이 이웃 밑에 깔려 있으면 되올렸다는 사실이 화면에 드러나지 않는다. 좌표가 아직 없는
  // Operation은 자리를 지어내지 않고 그대로 둔다: 처음 캔버스에 설 때 평소 초기 배치가 정한다.
  const restored = !minimized ? theaterState.operations[sessionId] : undefined;
  const operations = restored
    ? { ...theaterState.operations, [sessionId]: { ...restored, zIndex: nextZIndex(theaterState.operations) } }
    : theaterState.operations;
  writeStoredState(theaterId, {
    ...theaterState,
    operations,
    minimized: minimized
      ? [...theaterState.minimized, sessionId]
      : theaterState.minimized.filter((id) => id !== sessionId),
  });
  state = { ...state };
  emit();
}

function nextZIndex(operations: Record<string, OperationGeometry>): number {
  let top = 0;
  for (const geometry of Object.values(operations)) top = Math.max(top, geometry.zIndex ?? 0);
  return top + 1;
}

// 전 Theater의 최소화 id를 한 번에 모은다. 활성 Theater는 메모리 state를, 나머지는 저장 스냅샷을
// 읽으므로 호출부는 Theater 경계를 신경 쓰지 않는다. 반환 배열은 매번 새로 만들어지니 구독이 아니라
// 리렌더 시점의 파생값으로 쓴다(useSyncExternalStore에 그대로 물리면 무한 렌더).
export function getTheaterMinimizedIds(theaterIds: readonly string[]): readonly string[] {
  const ids: string[] = [];
  for (const theaterId of theaterIds) {
    for (const sessionId of getTheaterCanvasSnapshot(theaterId).minimized) ids.push(sessionId);
  }
  return ids;
}

// 균형 그리드의 열은 ceil(sqrt(n)), 행은 ceil(n / cols)로 정한다. 마지막 행에 슬롯이 모자라면
// 남은 패널들이 그 행의 전체 폭을 나눠 채워 빈 셀을 남기지 않는다. 최소 크기는 실제 가용 폭·높이로
// 캡해, 좁은 Formation 캔버스에서도 panel chrome이 clip되지 않게 한다.
// grid/rows 행 보폭은 본문 높이 + gap + 캡션이다. 캡션은 본문 위(top: -32px)에 붙으므로
// 피치에 넣지 않으면 아래 행이 위 행 본문을 침범한다. columns는 한 줄이라 첫 행 여백만
// 호출부가 지고, 이 함수는 가로 gap만 쓴다.
export function calculateGridSlots(
  rect: CanvasWorldRect,
  count: number,
  minimumWidth = MIN_OPERATION_WIDTH,
  minimumHeight = MIN_OPERATION_HEIGHT,
  gap = OPERATION_GRID_GAP,
  padding = OPERATION_GRID_PADDING,
  layout: FormationLayout = "grid",
): readonly GridSlotGeometry[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  const innerWidth = Math.max(0, rect.width - padding * 2);
  const innerHeight = Math.max(0, rect.height - padding * 2);
  if (layout === "columns") {
    const availableWidth = Math.max(0, innerWidth - gap * (count - 1));
    const naturalWidth = availableWidth / count;
    const effectiveMinWidth = Math.min(minimumWidth, naturalWidth);
    const width = Math.min(Math.max(effectiveMinWidth, naturalWidth), availableWidth);
    const naturalHeight = innerHeight;
    const effectiveMinHeight = Math.min(minimumHeight, naturalHeight);
    const height = Math.min(Math.max(effectiveMinHeight, naturalHeight), innerHeight);
    return Array.from({ length: count }, (_, index) => ({
      x: rect.x + padding + index * (width + gap),
      y: rect.y + padding,
      width,
      height,
    }));
  }
  if (layout === "rows") {
    const naturalWidth = innerWidth;
    const effectiveMinWidth = Math.min(minimumWidth, naturalWidth);
    const width = Math.min(Math.max(effectiveMinWidth, naturalWidth), innerWidth);
    const rowStride = gap + OPERATION_WINDOW_CAPTION_HEIGHT;
    const availableHeight = Math.max(0, innerHeight - rowStride * (count - 1));
    const naturalHeight = availableHeight / count;
    const effectiveMinHeight = Math.min(minimumHeight, naturalHeight);
    const height = Math.min(Math.max(effectiveMinHeight, naturalHeight), availableHeight);
    return Array.from({ length: count }, (_, index) => ({
      x: rect.x + padding,
      y: rect.y + padding + index * (height + rowStride),
      width,
      height,
    }));
  }
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const rowStride = gap + OPERATION_WINDOW_CAPTION_HEIGHT;
  const availableHeight = Math.max(0, innerHeight - rowStride * (rows - 1));
  const naturalHeight = availableHeight / rows;
  const effectiveMinHeight = Math.min(minimumHeight, naturalHeight);
  const height = Math.min(Math.max(effectiveMinHeight, naturalHeight), availableHeight);
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    // 마지막 행은 남은 패널 수 기준으로 폭을 재분배한다 — 3패널 2×2 그리드의 빈 셀 같은 공백을 없앤다.
    const columnsInRow = row === rows - 1 ? count - (rows - 1) * columns : columns;
    const availableWidth = Math.max(0, innerWidth - gap * (columnsInRow - 1));
    const naturalWidth = availableWidth / columnsInRow;
    const effectiveMinWidth = Math.min(minimumWidth, naturalWidth);
    const width = Math.min(Math.max(effectiveMinWidth, naturalWidth), availableWidth);
    return {
      x: rect.x + padding + column * (width + gap),
      y: rect.y + padding + row * (height + rowStride),
      width,
      height,
    };
  });
}

// Operation을 최소화한다 — 캔버스 렌더에서 빠지고 하단 태스크바에 표시된다. geometry는 operations에 보존한다.
export function minimizeOperation(sessionId: string): void {
  if (state.minimized.includes(sessionId)) return;
  if (getMaximizedOperationId() === sessionId) clearMaximizedOperationId();
  if (getCompanionOperationId() === sessionId) forceDropCompanionOperationId();
  setState({ minimized: [...state.minimized, sessionId] });
}

// 초기 부팅처럼 현재 존재하는 패널 집합을 최소화할 때 쓴다. 기존 최소화 순서는 보존하고 새 id만 뒤에 더한다.
export function minimizeOperations(sessionIds: readonly string[]): void {
  const seen = new Set<string>();
  const validMinimized = state.minimized.filter((sessionId) => {
    if (seen.has(sessionId) || !(sessionId in state.operations)) return false;
    seen.add(sessionId);
    return true;
  });
  const minimized = [...validMinimized, ...sessionIds.filter((sessionId) => {
    if (seen.has(sessionId) || !(sessionId in state.operations)) return false;
    seen.add(sessionId);
    return true;
  })];
  if (stringArraysEqual(state.minimized, minimized)) return;
  const maximizedOperationId = getMaximizedOperationId();
  const companionOperationId = getCompanionOperationId();
  if (maximizedOperationId && minimized.includes(maximizedOperationId)) clearMaximizedOperationId();
  if (companionOperationId && minimized.includes(companionOperationId)) forceDropCompanionOperationId();
  setState({ minimized });
}

// 최소화한 Operation을 복원한다 — 목록에서 제거하고 보존된 geometry를 최상단 zIndex로 끌어올려 원위치·원크기로 되돌린다.
// 활성화(selectTerminalSession)는 호출 측 책임으로 남겨, Operation 활성 조정을 한 곳(canvas)에서 유지한다.
export function restoreOperation(sessionId: string): void {
  if (!state.minimized.includes(sessionId)) return;
  if (getMaximizedOperationId() === sessionId) clearMaximizedOperationId();
  const minimized = state.minimized.filter((id) => id !== sessionId);
  const geometry = state.operations[sessionId];
  if (!geometry) {
    setState({ minimized });
    return;
  }
  const zIndex = claimTopZIndex();
  let restored: OperationGeometry = { ...geometry, zIndex };
  // Station Keeping 중에는 복원도 정착을 거친다 — 자리를 비운 사이 다른 패널이 그 자리를 쓸 수 있다.
  if (state.stationKeeping) {
    const spot = resolveStationKeepingPosition(restored, visibleObstacles(sessionId));
    restored = { ...restored, x: spot.x, y: spot.y };
  }
  setState({
    minimized,
    operations: { ...state.operations, [sessionId]: restored },
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

// 공유 z-index 카운터에서 다음 최상단 값을 발급한다. Operation을 활성화·생성할 때 호출한다.
export function claimTopZIndex(): number {
  topZIndex += 1;
  return topZIndex;
}

// 공유 카운터를 주어진 값 이상으로 끌어올린다. Operation 레지스트리가 새로고침 복원 시
// 복원된 셸의 최대 zIndex를 반영해, "활성화→최상단"이 Operations·셸을 가로질러 계속 성립하게 한다.
function liftTopZIndex(toAtLeast: number): void {
  topZIndex = Math.max(topZIndex, toAtLeast);
}

export function ensureDefaultGeometry(sessionId: string, persisted?: OperationGeometry | null): OperationGeometry {
  const existing = state.operations[sessionId];
  if (existing) return existing;
  const index = Object.keys(state.operations).length;
  let geometry: OperationGeometry = persisted ?? {
    x: index * DEFAULT_OPERATION_OFFSET,
    y: index * DEFAULT_OPERATION_OFFSET,
    width: DEFAULT_OPERATION_WIDTH,
    height: DEFAULT_OPERATION_HEIGHT,
    zIndex: claimTopZIndex(),
  };
  if (state.stationKeeping) {
    const spot = resolveStationKeepingPosition(geometry, visibleObstacles(sessionId));
    geometry = { ...geometry, x: spot.x, y: spot.y };
  }
  liftTopZIndex(geometry.zIndex);
  setState({ operations: { ...state.operations, [sessionId]: geometry } });
  return geometry;
}

// ── Station Keeping ──────────────────────────────────────────────────────────
// Cruise의 상시 비겹침 규율. 모든 계산은 월드 좌표이고 캔버스는 무한 평면이므로 해는 항상 존재한다.
// 충돌 상자는 본문 geometry가 아니라 창 캡션(top:-32px)을 더한 시각 프레임이다. 저장 좌표는 본문 그대로다.

interface StationKeepingRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// Formation 가이드와 같은 시각 프레임 — 캡션은 본문 위(top:-32px)에 붙으므로 본문 AABB만
// 보면 아래 패널 캡션이 위 패널 본문·캡션을 침범해도 규율이 침묵한다.
function stationKeepingFrameFor(body: StationKeepingRect): StationKeepingRect {
  return {
    x: body.x,
    y: body.y - OPERATION_WINDOW_CAPTION_HEIGHT,
    width: body.width,
    height: body.height + OPERATION_WINDOW_CAPTION_HEIGHT,
  };
}

// gap 이상 떨어져 있으면 clear — 정확히 gap만큼 떨어진 접촉은 규율을 만족한다.
function rectsClear(a: StationKeepingRect, b: StationKeepingRect, gap: number): boolean {
  return a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x
    || a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y;
}

// 목표 자리에서 가장 가까운 비겹침 좌표. 최적해의 x·y는 각각 "목표 그대로"이거나 "어떤 장애물
// 가장자리에 gap을 두고 붙는 값"이므로(위치 공간의 금지 영역이 축 정렬 사각형 합집합이라 최근접점은
// 그 경계·경계 교차점 위에 있다), 두 축 후보의 곱집합 전수 검사가 정확한 최근접 자리를 준다.
export function resolveClearPosition(
  target: StationKeepingRect,
  obstacles: readonly StationKeepingRect[],
  gap = STATION_KEEPING_GAP,
): { readonly x: number; readonly y: number } {
  if (obstacles.every((obstacle) => rectsClear(target, obstacle, gap))) return { x: target.x, y: target.y };
  const xCandidates = new Set<number>([target.x]);
  const yCandidates = new Set<number>([target.y]);
  for (const obstacle of obstacles) {
    xCandidates.add(obstacle.x - target.width - gap);
    xCandidates.add(obstacle.x + obstacle.width + gap);
    yCandidates.add(obstacle.y - target.height - gap);
    yCandidates.add(obstacle.y + obstacle.height + gap);
  }
  let best: { x: number; y: number } | null = null;
  let bestDistance = Infinity;
  for (const x of xCandidates) {
    for (const y of yCandidates) {
      const candidate = { x, y, width: target.width, height: target.height };
      if (obstacles.some((obstacle) => !rectsClear(candidate, obstacle, gap))) continue;
      const distance = (x - target.x) ** 2 + (y - target.y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { x, y };
      }
    }
  }
  return best ?? { x: target.x, y: target.y };
}

// 본문 좌표를 받아 시각 프레임으로 정착한 뒤 본문 좌표로 되돌린다.
function resolveStationKeepingPosition(
  body: StationKeepingRect,
  obstacleBodies: readonly StationKeepingRect[],
  gap = STATION_KEEPING_GAP,
): { readonly x: number; readonly y: number } {
  const spot = resolveClearPosition(
    stationKeepingFrameFor(body),
    obstacleBodies.map(stationKeepingFrameFor),
    gap,
  );
  return { x: spot.x, y: spot.y + OPERATION_WINDOW_CAPTION_HEIGHT };
}

// 규율의 장애물은 "보이는 Cruise 패널"뿐이다 — 최소화·모드 투영·접힘은 자리를 차지하지 않는다.
function visibleObstacles(excludeId: string | null): readonly StationKeepingRect[] {
  return Object.entries(state.operations)
    .filter(([sessionId]) => sessionId !== excludeId && !state.minimized.includes(sessionId))
    .map(([, geometry]) => geometry);
}

// 옵트인 순간과 불변식 복구의 일괄 정착. z 상위(최근 사용) 패널부터 자리를 확정해 사용자가 보고
// 있는 패널이 덜 움직인다(멘탈맵 보존 — Tactical의 재격자화가 아니다). 이미 비겹침이면 null.
function spreadVisibleOperations(
  operations: Record<string, OperationGeometry>,
  minimized: readonly string[],
): Record<string, OperationGeometry> | null {
  const minimizedSet = new Set(minimized);
  const sorted = Object.entries(operations)
    .filter(([sessionId]) => !minimizedSet.has(sessionId))
    .sort(([, a], [, b]) => b.zIndex - a.zIndex);
  const placed: StationKeepingRect[] = [];
  const next = { ...operations };
  let changed = false;
  for (const [sessionId, geometry] of sorted) {
    const spot = resolveStationKeepingPosition(geometry, placed);
    if (spot.x !== geometry.x || spot.y !== geometry.y) {
      next[sessionId] = { ...geometry, x: spot.x, y: spot.y };
      changed = true;
    }
    placed.push({ ...geometry, x: spot.x, y: spot.y });
  }
  return changed ? next : null;
}

export function getStationKeeping(): boolean {
  return state.stationKeeping;
}

export function useStationKeeping(): boolean {
  return useSyncExternalStore(subscribe, getStationKeeping, getStationKeeping);
}

// 옵트인은 즉시 한 번 펼친다. 옵트아웃은 좌표를 되돌리지 않는다 — 규율이 남긴 배치가 새 현실이다.
export function setStationKeeping(enabled: boolean): void {
  if (state.stationKeeping === enabled) return;
  if (!enabled) {
    setState({ stationKeeping: false });
    return;
  }
  const spread = spreadVisibleOperations(state.operations, state.minimized);
  setState({ stationKeeping: true, ...(spread ? { operations: spread } : {}) });
}

// 규율이 켜진 상태의 불변식 복구 — War Room 지도 이동처럼 규율 밖 쓰기가 남긴 겹침을 정착시킨다.
export function enforceStationKeeping(): void {
  if (!state.stationKeeping) return;
  const spread = spreadVisibleOperations(state.operations, state.minimized);
  if (spread) setState({ operations: spread });
}

// 단일 패널 정착(드래그·리사이즈 해제) — 만진 패널만 움직이고 이웃은 절대 움직이지 않는다.
export function settleOperationGeometry(sessionId: string): void {
  if (!state.stationKeeping) return;
  const geometry = state.operations[sessionId];
  if (!geometry || state.minimized.includes(sessionId)) return;
  const spot = resolveStationKeepingPosition(geometry, visibleObstacles(sessionId));
  if (spot.x === geometry.x && spot.y === geometry.y) return;
  setState({ operations: { ...state.operations, [sessionId]: { ...geometry, x: spot.x, y: spot.y } } });
}

// 생성 좌표 정착 — 규율은 Theater별 상태이므로 대상 Theater의 스냅샷을 따른다.
// 비활성 Theater(War Room 소유 영역 실행)는 저장된 스냅샷 기준으로 정착해 다음 방문 때 겹치지 않는다.
export function resolveLaunchGeometry(theaterId: string, geometry: OperationGeometry): OperationGeometry {
  const snapshot = activeTheaterId === theaterId ? state : readStoredState(theaterId);
  if (!snapshot.stationKeeping) return geometry;
  const minimizedSet = new Set(snapshot.minimized);
  const obstacles = Object.entries(snapshot.operations)
    .filter(([sessionId]) => !minimizedSet.has(sessionId))
    .map(([, existing]) => existing);
  const spot = resolveStationKeepingPosition(geometry, obstacles);
  if (spot.x === geometry.x && spot.y === geometry.y) return geometry;
  return { ...geometry, x: spot.x, y: spot.y };
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
  const maximizedOperationId = getMaximizedOperationId();
  const companionOperationId = getCompanionOperationId();
  if (maximizedOperationId && (!valid.has(maximizedOperationId) || minimized.includes(maximizedOperationId))) clearMaximizedOperationId();
  // companion은 목록 부재만으로 즉시 정리하지 않는다 — ops 푸시 레이스로 일시 부재가 흔하며,
  // 지속 부재의 정리는 캔버스 렌더 측 유예 효과가 소유한다. 최소화는 사용자 확정 액션이라 즉시 닫는다.
  if (companionOperationId && minimized.includes(companionOperationId)) forceDropCompanionOperationId();
  if (changed || minimizedChanged || orderChanged || accentChanged) {
    setState({ operations, minimized, operationOrder, operationAccent });
  }
}

export function loadForTheater(theaterId: string | null): void {
  flushScheduledSave();
  cancelZoomTween();
  saveFocusLayerForActiveTheater();
  activeTheaterId = theaterId;
  state = theaterId ? readStoredState(theaterId) : EMPTY_STATE;
  // maximize와 companion은 상호 배타적인 focus layer다. Theater별 단일 상태로 보존·복원해
  // 같은 Theater가 다시 로드돼도 현재 레이아웃 모드와 대상 Operation을 함께 유지한다.
  const nextFocusLayer = theaterId ? focusLayersByTheater.get(theaterId) ?? null : null;
  const focusLayerChanged = !focusLayersEqual(focusLayer, nextFocusLayer);
  focusLayer = nextFocusLayer;
  const nextFormationView = theaterId ? formationViewsByTheater.has(theaterId) : false;
  const formationChanged = formationView !== nextFormationView;
  formationView = nextFormationView;
  targetViewport = state.viewport;
  // 복원된 Operation의 최대 zIndex 위로 카운터를 끌어올린다 — 새로고침/Theater 전환 후에도 활성화→최상단을 보장한다.
  topZIndex = Math.max(topZIndex, maxZIndexOf(state.operations));
  // 규율이 켜진 Theater는 로드 시점에 불변식을 복구한다 — 비활성 상태에서 들어온 규율 밖 쓰기
  // (War Room 지도 이동 등)가 남긴 겹침을 정착시키고, 복구를 저장까지 수렴시켜 다음 로드가
  // 같은 복구를 반복하지 않게 한다(이탈 시 flushScheduledSave가 이 상태를 쓴다).
  if (state.stationKeeping) {
    const spread = spreadVisibleOperations(state.operations, state.minimized);
    if (spread) {
      state = { ...state, operations: spread };
      scheduleSave();
    }
  }
  emit();
  if (focusLayerChanged) emitFocusLayer();
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

export function setMaximizedOperationId(operationId: string): void {
  const nextFocusLayer = { mode: "maximized", operationId } as const;
  if (activeTheaterId) focusLayersByTheater.set(activeTheaterId, nextFocusLayer);
  // 최대화는 underlay(Map 또는 Formation)를 바꾸지 않는 렌더 전용 포커스 레이어다.
  // 대상만 실제 최소화 목록에서 꺼내 보이게 하고, peer의 실제 최소화 상태는 그대로 둔다.
  setFocusLayer(nextFocusLayer);
}

export function clearMaximizedOperationId(): void {
  if (activeTheaterId && focusLayersByTheater.get(activeTheaterId)?.mode === "maximized") focusLayersByTheater.delete(activeTheaterId);
  if (focusLayer?.mode !== "maximized") return;
  focusLayer = null;
  emitFocusLayer();
}

export function setCompanionOperationId(operationId: string): void {
  // ANALYZE 진입마다 descriptor 기본 가시성에서 다시 시작하고, 플러그인이 현재 artifact 상태로 보정한다.
  clearCompanionPanelVisibilityOverrides(operationId);
  const returnTo = focusLayer?.mode === "companion"
    ? focusLayer.returnTo
    : focusLayer?.mode === "maximized" ? "maximized" : "underlay";
  const nextFocusLayer = { mode: "companion", operationId, returnTo } as const;
  setFocusLayer(nextFocusLayer);
}

function setFocusLayer(nextFocusLayer: FocusLayerState): void {
  // companion 대상이 다른 레이어로 교체되는 전이(retarget·maximize)도 이전 대상의
  // 가시성 오버라이드를 정리한다 — Theater 전환 보존은 이 함수를 타지 않는다.
  if (focusLayer?.mode === "companion" && !(nextFocusLayer.mode === "companion" && nextFocusLayer.operationId === focusLayer.operationId)) {
    clearCompanionPanelVisibilityOverrides(focusLayer.operationId);
  }
  const minimized = state.minimized.filter((sessionId) => sessionId !== nextFocusLayer.operationId);
  const minimizedChanged = !stringArraysEqual(state.minimized, minimized);
  const focusLayerChanged = !focusLayersEqual(focusLayer, nextFocusLayer);
  if (focusLayerChanged) focusLayer = nextFocusLayer;
  if (focusLayerChanged && activeTheaterId) focusLayersByTheater.set(activeTheaterId, nextFocusLayer);
  if (minimizedChanged) setState({ minimized });
  if (focusLayerChanged) emitFocusLayer();
}

export function clearCompanionOperationId(): void {
  if (focusLayer?.mode !== "companion") return;
  const closingLayer = focusLayer;
  const canRestoreMaximized = closingLayer.returnTo === "maximized"
    && closingLayer.operationId in state.operations
    && !state.minimized.includes(closingLayer.operationId);
  focusLayer = canRestoreMaximized
    ? { mode: "maximized", operationId: closingLayer.operationId }
    : null;
  if (activeTheaterId) {
    if (focusLayer) focusLayersByTheater.set(activeTheaterId, focusLayer);
    else focusLayersByTheater.delete(activeTheaterId);
  }
  clearCompanionPanelVisibilityOverrides(closingLayer.operationId);
  emitFocusLayer();
}

export function forceDropCompanionOperationId(): void {
  if (focusLayer?.mode !== "companion") return;
  const closingOperationId = focusLayer.operationId;
  focusLayer = null;
  if (activeTheaterId) focusLayersByTheater.delete(activeTheaterId);
  clearCompanionPanelVisibilityOverrides(closingOperationId);
  emitFocusLayer();
}

export function toggleFormationView(): void {
  if (!activeTheaterId) return;
  if (getCompanionOperationId() !== null) {
    beforeFormationViewActivation?.(activeTheaterId);
    forceDropCompanionOperationId();
    if (!formationView) {
      markFormationTheater(activeTheaterId);
      formationView = true;
      emitFormationView();
    }
    return;
  }
  if (formationView) {
    clearFormationView();
    return;
  }
  beforeFormationViewActivation?.(activeTheaterId);
  clearMaximizedOperationId();
  forceDropCompanionOperationId();
  markFormationTheater(activeTheaterId);
  formationView = true;
  emitFormationView();
}

export function selectFormationLayout(layout: FormationLayout): void {
  if (!activeTheaterId) return;
  if (getCompanionOperationId() !== null) {
    setFormationLayout(layout);
    beforeFormationViewActivation?.(activeTheaterId);
    forceDropCompanionOperationId();
    if (!formationView) {
      markFormationTheater(activeTheaterId);
      formationView = true;
      emitFormationView();
    }
    return;
  }
  if (formationView && formationLayout === layout) {
    clearFormationView();
    return;
  }
  setFormationLayout(layout);
  if (!formationView) {
    beforeFormationViewActivation?.(activeTheaterId);
    clearMaximizedOperationId();
    forceDropCompanionOperationId();
    markFormationTheater(activeTheaterId);
    formationView = true;
    emitFormationView();
  }
}

export function clearFormationView(theaterId = activeTheaterId): void {
  if (theaterId) unmarkFormationTheater(theaterId);
  if (activeTheaterId !== theaterId || !formationView) return;
  formationView = false;
  emitFormationView();
}

// Tactical은 Theater별 상태라 목록으로 기억한다. 모듈 메모리와 탭 세션을 한 지점에서만 갱신해
// 두 기록이 갈라지지 않게 한다.
function markFormationTheater(theaterId: string): void {
  if (formationViewsByTheater.has(theaterId)) return;
  formationViewsByTheater.set(theaterId, true);
  rememberFormationTheaters(formationViewsByTheater.keys());
}

function unmarkFormationTheater(theaterId: string): void {
  if (!formationViewsByTheater.delete(theaterId)) return;
  rememberFormationTheaters(formationViewsByTheater.keys());
}

export function registerBeforeFormationViewActivation(listener: (theaterId: string) => void): void {
  beforeFormationViewActivation = listener;
}

export function setFormationLayout(layout: FormationLayout): void {
  formationLayout = layout;
  writeStoredFormationLayout(layout);
  emitFormationLayout();
}

function subscribeFormationView(listener: Listener): () => void {
  formationViewListeners.add(listener);
  return () => {
    formationViewListeners.delete(listener);
  };
}

function subscribeFormationLayout(listener: Listener): () => void {
  formationLayoutListeners.add(listener);
  return () => {
    formationLayoutListeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribeFocusLayer(listener: Listener): () => void {
  focusLayerListeners.add(listener);
  return () => {
    focusLayerListeners.delete(listener);
  };
}

function subscribeCompanionPanelVisibility(listener: Listener): () => void {
  companionPanelVisibilityListeners.add(listener);
  return () => {
    companionPanelVisibilityListeners.delete(listener);
  };
}

function getCompanionPanelVisibilitySnapshot(): CompanionPanelVisibilityOverrides {
  return companionPanelVisibilityOverrides;
}

function emitCompanionPanelVisibility(): void {
  for (const listener of companionPanelVisibilityListeners) listener();
}

function clearCompanionPanelVisibilityOverrides(operationId: string): void {
  if (!(operationId in companionPanelVisibilityOverrides)) return;
  const remaining = { ...companionPanelVisibilityOverrides };
  delete remaining[operationId];
  companionPanelVisibilityOverrides = remaining;
  emitCompanionPanelVisibility();
}

function emitFormationView(): void {
  for (const listener of formationViewListeners) listener();
}

function emitFormationLayout(): void {
  for (const listener of formationLayoutListeners) listener();
}

function getMinimizedSnapshot(): readonly string[] {
  return state.minimized;
}

function getCollapsedGroupsSnapshot(): readonly string[] {
  return state.collapsedGroups;
}

function emitFocusLayer(): void {
  focusLayerRevision += 1;
  for (const listener of focusLayerListeners) listener();
}

function saveFocusLayerForActiveTheater(): void {
  if (!activeTheaterId) return;
  if (focusLayer) focusLayersByTheater.set(activeTheaterId, focusLayer);
  else focusLayersByTheater.delete(activeTheaterId);
}

function focusLayersEqual(left: FocusLayerState | null, right: FocusLayerState | null): boolean {
  return left?.mode === right?.mode
    && left?.operationId === right?.operationId
    && (left?.mode !== "companion" || right?.mode !== "companion" || left.returnTo === right.returnTo);
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

export function prefersReducedMotion(): boolean {
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

function readStoredFormationLayout(): FormationLayout {
  if (typeof window === "undefined") return "grid";
  try {
    const stored = window.localStorage.getItem(FORMATION_LAYOUT_STORAGE_KEY);
    return stored === "columns" || stored === "rows" || stored === "grid" ? stored : "grid";
  } catch {
    return "grid";
  }
}

function writeStoredFormationLayout(layout: FormationLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FORMATION_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // 저장 실패는 Formation 레이아웃 복구성만 낮추므로 런타임 흐름을 막지 않는다.
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
    minimized: normalizeMinimized(value.minimized),
    collapsedGroups: normalizeStringArray(value.collapsedGroups),
    stationKeeping: value.stationKeeping === true,
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

// 최소화 목록의 진실은 "사용자가 내렸다"이지 "좌표가 저장돼 있다"가 아니다. War Room은 Cruise 캔버스에
// 한 번도 놓인 적 없는 Operation도 판에서 내리므로 좌표 유무로 거르면 방금 내린 항목이 다음 읽기에서
// 사라진다. 사라진 세션 정리는 실 Operation 목록을 아는 pruneOperations가 이미 전담한다.
function normalizeMinimized(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const minimized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || seen.has(entry)) continue;
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
