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

export type FormationLayout = "grid" | "columns" | "rows";

type Listener = () => void;
type FocusLayerState =
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
export const OPERATION_GRID_GAP = 8;
export const OPERATION_GRID_PADDING = 0;
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
const focusLayerListeners = new Set<Listener>();
const companionPanelVisibilityListeners = new Set<Listener>();
const formationViewListeners = new Set<Listener>();
const formationLayoutListeners = new Set<Listener>();
const focusLayersByTheater = new Map<string, FocusLayerState>();
const formationViewsByTheater = new Map<string, true>();
let activeTheaterId: string | null = null;
let saveTimer: number | null = null;
let state: CanvasState = EMPTY_STATE;
let focusLayer: FocusLayerState | null = null;
let focusLayerRevision = 0;
let companionPanelVisibilityOverrides: CompanionPanelVisibilityOverrides = {};
let formationView = false;
let formationLayout = readStoredFormationLayout();
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

export function setOperationGeometry(sessionId: string, geometry: OperationGeometry): void {
  const zIndex = claimTopZIndex();
  setState({
    operations: {
      ...state.operations,
      [sessionId]: { ...normalizeOperationGeometry(geometry, zIndex), zIndex },
    },
  });
}

// 균형 그리드의 열은 ceil(sqrt(n)), 행은 ceil(n / cols)로 정한다. 마지막 행에 슬롯이 모자라면
// 남은 패널들이 그 행의 전체 폭을 나눠 채워 빈 셀을 남기지 않는다. 최소 크기는 실제 가용 폭·높이로
// 캡해, 좁은 Formation 캔버스에서도 panel chrome이 clip되지 않게 한다.
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
    const availableHeight = Math.max(0, innerHeight - gap * (count - 1));
    const naturalHeight = availableHeight / count;
    const effectiveMinHeight = Math.min(minimumHeight, naturalHeight);
    const height = Math.min(Math.max(effectiveMinHeight, naturalHeight), availableHeight);
    return Array.from({ length: count }, (_, index) => ({
      x: rect.x + padding,
      y: rect.y + padding + index * (height + gap),
      width,
      height,
    }));
  }
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const availableHeight = Math.max(0, innerHeight - gap * (rows - 1));
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
      y: rect.y + padding + row * (height + gap),
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
    forceDropCompanionOperationId();
    if (!formationView) {
      formationViewsByTheater.set(activeTheaterId, true);
      formationView = true;
      emitFormationView();
    }
    return;
  }
  if (formationView) {
    clearFormationView();
    return;
  }
  clearMaximizedOperationId();
  forceDropCompanionOperationId();
  formationViewsByTheater.set(activeTheaterId, true);
  formationView = true;
  emitFormationView();
}

export function selectFormationLayout(layout: FormationLayout): void {
  if (!activeTheaterId) return;
  if (getCompanionOperationId() !== null) {
    setFormationLayout(layout);
    forceDropCompanionOperationId();
    if (!formationView) {
      formationViewsByTheater.set(activeTheaterId, true);
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
    clearMaximizedOperationId();
    forceDropCompanionOperationId();
    formationViewsByTheater.set(activeTheaterId, true);
    formationView = true;
    emitFormationView();
  }
}

export function clearFormationView(): void {
  if (activeTheaterId) formationViewsByTheater.delete(activeTheaterId);
  if (!formationView) return;
  formationView = false;
  emitFormationView();
}

export function setFormationLayout(layout: FormationLayout): void {
  formationLayout = layout;
  writeStoredFormationLayout(layout);
  emitFormationLayout();
}

export function subscribeFormationView(listener: Listener): () => void {
  formationViewListeners.add(listener);
  return () => {
    formationViewListeners.delete(listener);
  };
}

export function subscribeFormationLayout(listener: Listener): () => void {
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
