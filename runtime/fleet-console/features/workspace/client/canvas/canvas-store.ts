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
  readonly operationAccent: Record<string, string>;
  // 최소화된 Operation id 목록. geometry는 operations에 그대로 보존되므로 복원은 원위치·원크기로 되돌린다.
  readonly minimized: readonly string[];
  // 접힌 그룹 id 목록(per-Theater localStorage). 접힘은 시각 표시 상태라 클라이언트 SSoT.
  readonly collapsedGroups: readonly string[];
  // Station Keeping — Cruise의 상시 비겹침 규율(옵트인, Theater별). 켜는 순간 한 번 펼치고,
  // 켜져 있는 동안 생성·이동·리사이즈·복원이 정착을 거친다. 끄는 것은 좌표를 되돌리지 않는다.
  readonly stationKeeping: boolean;
  readonly snapHold: SnapHold | null;
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

/**
 * 스냅 유지 — 스냅한 패널만 아레나 분수 칸으로 기억한다. 유지 중인 패널은 카메라·크롬(사이드바·레일)이
 * 어떻게 바뀌든 "지금 보이는 아레나"의 그 칸에 다시 깔리고, 비어 있는 칸은 다음 패널을 받는다.
 * 칸은 프리셋에서 시작하되 유지 패널 사이 경계를 끌면 이웃과 함께 변한다. 자유 패널은 영향받지 않는다.
 * Cruise에서 줌을 만지면 전부 풀리고, 유지 패널을 칸 밖에 놓거나 최소화·닫으면 그 패널만 풀린다.
 * War Room은 자기 기하로 덮을 뿐이라 왕복해도 남는다. 모두 정렬도 유지의 한 종류라 Theater별
 * CanvasState에 그대로 남아 Theater를 다녀오거나 새로고침해도 이어진다.
 */
export type SnapZoneFraction = readonly [number, number, number, number];
export interface SnapHold {
  readonly presetId: string;
  readonly zones: readonly SnapZoneFraction[];
  /** 세션 id → zones 인덱스. */
  readonly assignments: Readonly<Record<string, number>>;
  /** 모두 정렬이 켜져 있으면 이 묶음은 자동 채움이다 — 칸은 보이는 패널 수와 레이아웃에서 다시 나눈다. */
  readonly alignAll?: AlignAllMeta | null;
}

/** 모두 정렬의 칸 나누기 — 격자·열·행. 켜져 있는 동안 캡슐 버튼으로 바꾼다. */
export type AlignAllLayout = "grid" | "columns" | "rows";

export interface AlignAllMeta {
  readonly layout: AlignAllLayout;
  /** 켜기 직전 각 패널의 Cruise 자리. 켠 뒤 들어온 패널은 여기에 없어 끌 때 기본 자리로 보낸다. */
  readonly savedGeometries: Readonly<Record<string, OperationGeometry>>;
  /** 켜기 직전 수동 유지 묶음 — 끌 때 자리와 함께 복원한다. */
  readonly savedSnapHold: SnapHold | null;
  /** 묶음에서 뺀 패널 id — 바깥에 둔 채 두며, 다시 넣거나 끄기 전까지 자동 채움에 들지 않는다. */
  readonly detached: readonly string[];
}

type Listener = () => void;
export type FocusLayerState =
  | { readonly mode: "maximized"; readonly operationId: string }
  | { readonly mode: "companion"; readonly operationId: string; readonly returnTo: "underlay" | "maximized" };
type CompanionPanelVisibilityOverrides = Record<string, Readonly<Record<string, boolean>>>;

const STORAGE_KEY_PREFIX = "fleet-console.canvas.";
const ALIGN_ALL_LAYOUT_STORAGE_KEY = "fleet-console.align-all-layout";
// 퇴역한 Tactical 레이아웃 키 — 첫 읽기에서 새 키로 한 번 이관하고 지운다.
const LEGACY_FORMATION_LAYOUT_STORAGE_KEY = "fleet-console.formation-layout";
const SAVE_DELAY_MS = 400;
const DEFAULT_OPERATION_WIDTH = 640;
const DEFAULT_OPERATION_HEIGHT = 400;
const DEFAULT_OPERATION_OFFSET = 40;
export const MIN_OPERATION_WIDTH = 320;
export const MIN_OPERATION_HEIGHT = 200;
// 본문 위에 붙는 창 캡션 높이. CSS top:-32px / height:32px 와 한 값이다.
// grid/rows 행 보폭에 넣어 아래 행 캡션이 위 행 본문을 침범하지 않게 한다.
export const OPERATION_WINDOW_CAPTION_HEIGHT = 32;
const OPERATION_FOCUS_PADDING = 96;
// 불러온 패널이 아레나보다 클 때 왼쪽 위에 남기는 여백 — 모드 프레임 여백과 같은 값.
const FOCUS_BRING_IN_INSET = 18;
// 이 아래 줌은 판독 불가(Fleet Map 영역, 이탈 문턱 0.24 위) — 포커스가 카메라를 여기까지 끌어올린다.
const FOCUS_READABLE_ZOOM = 0.25;
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
const EMPTY_STATE: CanvasState = { viewport: DEFAULT_VIEWPORT, operations: {}, operationAccent: {}, minimized: [], collapsedGroups: [], stationKeeping: false, snapHold: null };
// Station Keeping이 유지하는 패널 사이 최소 간격(월드 단위). 줌과 무관하게 월드 좌표로만 계산한다.
// 충돌 상자는 본문이 아니라 창 캡션(top:-32px)을 더한 시각 프레임이다.
export const STATION_KEEPING_GAP = 16;

const listeners = new Set<Listener>();
const focusLayerListeners = new Set<Listener>();
const companionPanelVisibilityListeners = new Set<Listener>();
const alignLayoutListeners = new Set<Listener>();
const focusLayersByTheater = new Map<string, FocusLayerState>();
let activeTheaterId: string | null = null;
let saveTimer: number | null = null;
let state: CanvasState = EMPTY_STATE;
let focusLayer: FocusLayerState | null = null;
let focusLayerRevision = 0;
let companionPanelVisibilityOverrides: CompanionPanelVisibilityOverrides = {};
// 모두 정렬이 꺼져 있을 때 캡슐이 가리키는 나누기 — 켜져 있는 동안은 유지 묶음 안의 layout이 진실이다.
// 옛 formation-layout 키에 남아 있던 선택은 첫 읽기에서 한 번 이관하고 그 키는 지운다.
let alignLayout = readStoredAlignLayout();
let canvasViewportSize: CanvasViewportSize = { width: 0, height: 0 };
let fitAllOperationsPending = false;
// 줌 보간 루프가 향하는 목표 viewport. 즉시 이동(pan/focus/load)은 이 값을 current와 동기화해 잔여 보간을 무효화한다.
let targetViewport: CanvasViewport = DEFAULT_VIEWPORT;
let zoomRaf: number | null = null;
// 모두 정렬 진입 직전에 한 번 부른다 — War Room이 선별 중이면 여기서 끝낸다.
// 등록은 triage-store가 맡아 스토어 순환 참조 없이 진입 계약을 한 곳에 둔다.
let beforeAlignAllActivation: ((theaterId: string) => void) | null = null;
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

/** 모두 정렬 메타 — 꺼져 있으면 null. Theater별 CanvasState에 살아 Theater를 다녀와도 이어진다. */
export function getAlignAll(): AlignAllMeta | null {
  return state.snapHold?.alignAll ?? null;
}

export function getAlignLayout(): AlignAllLayout {
  return state.snapHold?.alignAll?.layout ?? alignLayout;
}

// canvas 스토어가 현재 로드한 Theater id. focus layer 상태는 이 Theater 기준으로
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

export function useAlignAll(): AlignAllMeta | null {
  return useSyncExternalStore(subscribe, getAlignAll, getAlignAll);
}

export function useAlignLayout(): AlignAllLayout {
  return useSyncExternalStore(subscribeAlignLayout, getAlignLayout, getAlignLayout);
}

// 최소화 목록은 CanvasState의 일부라 메인 listeners/emit을 그대로 공유한다(별도 채널 불필요).
export function useMinimized(): readonly string[] {
  return useSyncExternalStore(subscribe, getMinimizedSnapshot, getMinimizedSnapshot);
}

export function setState(patch: Partial<CanvasState>): void {
  state = {
    viewport: patch.viewport ?? state.viewport,
    operations: patch.operations ?? state.operations,
    operationAccent: patch.operationAccent ?? state.operationAccent,
    minimized: patch.minimized ?? state.minimized,
    collapsedGroups: patch.collapsedGroups ?? state.collapsedGroups,
    stationKeeping: patch.stationKeeping ?? state.stationKeeping,
    // null이 유효한 값이라 ??로 합치면 해제가 사라진다.
    snapHold: patch.snapHold !== undefined ? patch.snapHold : state.snapHold,
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

// ── 늘 숨은 패널 ────────────────────────────────────────────────────────────────
// 기하 전역 읽기(전체 맞춤·Station Keeping 장애물·정착)는 최소화한 패널을 거른다. 구성원은 기본 목록에 없어
// 좌표를 받지 않고, 남은 좌표도 정리(pruneOperations)가 걷으므로 따로 셀 것이 없다.
function hiddenGeometryIds(minimized: readonly string[] = state.minimized): Set<string> {
  return new Set(minimized);
}

export function fitAllOperations(): void {
  if (focusLayer !== null || canvasViewportSize.width <= 0 || canvasViewportSize.height <= 0) return;
  // 맞춤도 줌이다 — 유지를 푼다(모두 정렬이면 켜기 전 자리 복원 없이 그 자리에 남는다).
  releaseSnapHold();
  // 분모와 중심은 캔버스 박스가 아니라 아레나다 — 전면 캔버스에서 박스 크기로 맞추면
  // 가장자리 패널이 부유 크롬 밑에 착지하고 그 중심이 viewport로 영속된다.
  const arenaWidth = Math.max(1, canvasViewportSize.width - canvasArenaInsets.left - canvasArenaInsets.right);
  const arenaHeight = Math.max(1, canvasViewportSize.height - canvasArenaInsets.top - canvasArenaInsets.bottom);
  const minimized = hiddenGeometryIds();
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
    // 활성 경로와 같다 — 최소화는 그 패널을 유지에서 뺀다. 남겨 두면 그 Theater로 돌아왔을 때 보이지 않는
    // 패널이 칸을 쥐고 있어 다른 패널을 받지 못한다.
    snapHold: minimized ? snapHoldWithout(theaterState.snapHold, [sessionId]) : theaterState.snapHold,
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

// 모두 정렬 칸 나누기 — 보이는 패널 수만큼 스냅 칸 분수를 만든다.
// grid: 열은 ceil(sqrt(n)), 행은 ceil(n / cols)이며 마지막 행은 남은 패널 수로 폭을
// 재분배해 빈칸을 만들지 않는다. columns는 세로 띠 n개, rows는 가로 띠 n개다.
// 분수라 snapZonesFor가 수동 스냅과 같은 18px 인셋·8px 간격·캡션 32px 문법으로 편다.
export function alignZonesFor(count: number, layout: AlignAllLayout = "grid"): readonly SnapZoneFraction[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  if (layout === "columns") {
    return Array.from({ length: count }, (_, index) => [index / count, 0, 1 / count, 1] as SnapZoneFraction);
  }
  if (layout === "rows") {
    return Array.from({ length: count }, (_, index) => [0, index / count, 1, 1 / count] as SnapZoneFraction);
  }
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const columnsInRow = row === rows - 1 ? count - (rows - 1) * columns : columns;
    return [column / columnsInRow, row / rows, 1 / columnsInRow, 1 / rows] as SnapZoneFraction;
  });
}

// Operation을 최소화한다 — 캔버스 렌더에서 빠지고 하단 태스크바에 표시된다. geometry는 operations에 보존한다.
export function minimizeOperation(sessionId: string): void {
  if (state.minimized.includes(sessionId)) return;
  if (getMaximizedOperationId() === sessionId) clearMaximizedOperationId();
  if (getCompanionOperationId() === sessionId) forceDropCompanionOperationId();
  setState({ minimized: [...state.minimized, sessionId], snapHold: snapHoldWithout(state.snapHold, [sessionId]) });
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
  setState({ minimized, snapHold: snapHoldWithout(state.snapHold, minimized) });
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

export function ensureDefaultGeometry(sessionId: string, persisted?: OperationGeometry | null, initiallyMinimized = false): OperationGeometry {
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
  if (initiallyMinimized) {
    if (getMaximizedOperationId() === sessionId) clearMaximizedOperationId();
    if (getCompanionOperationId() === sessionId) forceDropCompanionOperationId();
  }
  // 첫 기하와 최소화를 한 스냅샷에 심어 새 휴면 패널이 펼쳐진 프레임을 만들지 않는다.
  setState({
    operations: { ...state.operations, [sessionId]: geometry },
    ...(initiallyMinimized && !state.minimized.includes(sessionId)
      ? { minimized: [...state.minimized, sessionId], snapHold: snapHoldWithout(state.snapHold, [sessionId]) }
      : {}),
  });
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

// 스냅 칸과 같은 시각 프레임 — 캡션은 본문 위(top:-32px)에 붙으므로 본문 AABB만
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
  const hidden = hiddenGeometryIds();
  return Object.entries(state.operations)
    .filter(([sessionId]) => sessionId !== excludeId && !hidden.has(sessionId))
    .map(([, geometry]) => geometry);
}

// 옵트인 순간과 불변식 복구의 일괄 정착. z 상위(최근 사용) 패널부터 자리를 확정해 사용자가 보고
// 있는 패널이 덜 움직인다(멘탈맵 보존 — Tactical의 재격자화가 아니다). 이미 비겹침이면 null.
function spreadVisibleOperations(
  operations: Record<string, OperationGeometry>,
  minimizedSet: ReadonlySet<string>,
): Record<string, OperationGeometry> | null {
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
  const spread = spreadVisibleOperations(state.operations, hiddenGeometryIds());
  setState({ stationKeeping: true, ...(spread ? { operations: spread } : {}) });
}

/** 아레나 — 캔버스 박스에서 부유 크롬 인셋을 뺀 유효 뷰포트(캔버스 박스 좌표). 크기를 모르면 null. */
export function getCanvasArenaRect(): CanvasWorldRect | null {
  if (canvasViewportSize.width <= 0 || canvasViewportSize.height <= 0) return null;
  return {
    x: canvasArenaInsets.left,
    y: canvasArenaInsets.top,
    width: Math.max(0, canvasViewportSize.width - canvasArenaInsets.left - canvasArenaInsets.right),
    height: Math.max(0, canvasViewportSize.height - canvasArenaInsets.top - canvasArenaInsets.bottom),
  };
}

// 모드 프레임은 가로로 부유 카드에 다가선다(canvas.tsx modeArena: 인셋−14). 스냅 칸도 Tactical 슬롯과
// 같은 상자를 쓴다 — 아레나 기준이면 칸이 사이드바·레일에서 한 걸음 더 물러나 좌우 여백이 벌어진다.
const MODE_ARENA_CHROME_PULL = 14;

/** 스냅 칸의 기준 상자 — 아레나-상대 좌표(아레나 원점이 0,0)로 돌려준다. 크기를 모르면 null. */
export function getCanvasSnapArenaRect(): CanvasWorldRect | null {
  const arena = getCanvasArenaRect();
  if (!arena) return null;
  const left = Math.max(0, canvasArenaInsets.left - MODE_ARENA_CHROME_PULL);
  const right = Math.max(0, canvasArenaInsets.right - MODE_ARENA_CHROME_PULL);
  return {
    x: left - canvasArenaInsets.left,
    y: 0,
    width: Math.max(0, canvasViewportSize.width - left - right),
    height: arena.height,
  };
}

/**
 * 스냅 — 아레나-상대 화면 칸(본문 사각형)에 패널을 앉힌다. 스냅은 사용자가 고른 자리라 Station
 * Keeping 정착을 거치지 않고, 활성화와 같이 최상단으로 올라온다.
 *
 * 줌은 항상 100%로 돌아온다 — 칸을 줌 100% 기준 월드 프레임으로 두고 카메라를 그 프레임으로 당긴다.
 * 패널의 고유 크기가 "화면 한 칸"으로 일정해지고, 줌이 빠진 채 스냅해도 작은 글자의 큰 패널이 남지 않는다.
 */
export interface SnapHoldTarget {
  readonly presetId: string;
  readonly zones: readonly SnapZoneFraction[];
  readonly zoneIndex: number;
}

export function snapOperationToArenaRect(sessionId: string, bodyRect: CanvasWorldRect, target?: SnapHoldTarget): void {
  // 모두 정렬이 켜져 있으면 유지 슬롯은 정렬이 소유한다 — 수동 스냅은 그 패널을 묶음에서
  // 빼고(나머지는 다시 나눈다) 칸 자리에는 유지 없이 앉힌다. 정렬 자체는 계속된다.
  if (state.snapHold?.alignAll) {
    snapFreePanelToArenaRect(sessionId, bodyRect);
    return;
  }
  const zIndex = claimTopZIndex();
  // 줌 100% 프레임 — 지금 아레나 좌상단이 가리키는 월드 점을 원점으로 칸을 1:1로 놓는다.
  const originX = -state.viewport.x / state.viewport.zoom;
  const originY = -state.viewport.y / state.viewport.zoom;
  const world = { x: originX + bodyRect.x, y: originY + bodyRect.y, width: bodyRect.width, height: bodyRect.height, zIndex };
  // 유지 — 같은 칸 나누기면 묶음에 합류하고(그 칸을 쓰던 패널은 풀린다), 다른 나누기면 새 묶음이 선다.
  // 이전 묶음의 패널은 좌표를 그대로 둔 채 자유 패널로 남는다.
  let snapHold = state.snapHold;
  if (target) {
    const sameZones = snapHold !== null && snapZonesEqual(snapHold.zones, target.zones);
    const assignments: Record<string, number> = {};
    if (sameZones) for (const [id, index] of Object.entries(snapHold!.assignments)) if (id !== sessionId && index !== target.zoneIndex) assignments[id] = index;
    assignments[sessionId] = target.zoneIndex;
    snapHold = { presetId: target.presetId, zones: sameZones ? snapHold!.zones : target.zones, assignments };
  }
  setState({
    operations: { ...state.operations, [sessionId]: { ...normalizeOperationGeometry(world, zIndex), zIndex } },
    minimized: state.minimized.includes(sessionId) ? state.minimized.filter((id) => id !== sessionId) : state.minimized,
    snapHold,
  });
  if (Math.abs(state.viewport.zoom - 1) > ZOOM_TWEEN_ZOOM_EPSILON || Math.abs(state.viewport.x + originX) > ZOOM_TWEEN_POSITION_EPSILON || Math.abs(state.viewport.y + originY) > ZOOM_TWEEN_POSITION_EPSILON) {
    animateViewportTo({ x: -originX, y: -originY, zoom: 1 });
  }
}

export function getSnapHold(): SnapHold | null {
  return state.snapHold;
}

export function useSnapHold(): SnapHold | null {
  return useSyncExternalStore(subscribe, getSnapHold, getSnapHold);
}

/** 캔버스가 렌더마다 칸에서 편 유지 패널의 월드 기하를 스토어에 되쓴다 — 영속·Station Keeping 장애물·해제가 같은 값을 본다. */
export function syncSnapHoldGeometry(entries: readonly { readonly sessionId: string; readonly rect: CanvasWorldRect }[]): void {
  let operations = state.operations;
  for (const { sessionId, rect } of entries) {
    const current = operations[sessionId];
    if (!current) continue;
    if (Math.abs(current.x - rect.x) < 0.01 && Math.abs(current.y - rect.y) < 0.01 && Math.abs(current.width - rect.width) < 0.01 && Math.abs(current.height - rect.height) < 0.01) continue;
    operations = { ...operations, [sessionId]: { ...current, x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }
  if (operations !== state.operations) setState({ operations });
}

export function setSnapHoldZones(zones: readonly SnapZoneFraction[]): void {
  if (!state.snapHold || snapZonesEqual(state.snapHold.zones, zones)) return;
  setState({ snapHold: { ...state.snapHold, zones } });
}

export function releaseSnapHold(): void {
  if (state.snapHold) setState({ snapHold: null });
}

export function releaseSnapHoldOperation(sessionId: string): void {
  // 모두 정렬 중에는 묶음에서 빼고 나머지를 다시 나눈다 — 렌더의 reconcile이 칸을 고친다.
  if (state.snapHold?.alignAll) {
    detachAlignAllPanel(sessionId);
    return;
  }
  const next = snapHoldWithout(state.snapHold, [sessionId]);
  if (next !== state.snapHold) setState({ snapHold: next });
}

// ── 모두 정렬 ────────────────────────────────────────────────────────────────
// 스냅 유지의 자동 채움 종류다. 켜면 보이는 패널 전부가 사이드바 순서로 칸을 받고, 끄면
// 켜기 전 자리로 돌아간다. 칸 할당은 렌더가 쥔 사이드바 순서에서 파생되므로 스토어는 묶음의
// 골격(칸·빼낸 패널·켜기 전 기억)만 진다. 최소화·추가·닫힘·순서 변경·자리 교환·빼내기는
// reconcile이 같은 규칙으로 다시 나눈다.

/** 모두 정렬 토글 — 켜면 기억하고 묶고, 끄면 켜기 전 자리(수동 묶음 포함)로 돌려놓는다. */
export function toggleAlignAll(): void {
  if (!activeTheaterId) return;
  const hold = state.snapHold;
  if (hold?.alignAll) {
    turnAlignAllOff(hold);
    return;
  }
  beforeAlignAllActivation?.(activeTheaterId);
  const savedGeometries = { ...state.operations };
  const savedSnapHold = hold ? { ...hold, assignments: { ...hold.assignments } } : null;
  setState({
    snapHold: {
      presetId: "align-all",
      zones: [],
      assignments: {},
      alignAll: { layout: alignLayout, savedGeometries, savedSnapHold, detached: [] },
    },
  });
  // 정렬도 스냅 가족이라 줌 100%다 — 지금 보이는 화면을 그대로 두고 배율만 돌린다.
  if (Math.abs(state.viewport.zoom - 1) > ZOOM_TWEEN_ZOOM_EPSILON) {
    animateViewportTo({ x: state.viewport.x / state.viewport.zoom, y: state.viewport.y / state.viewport.zoom, zoom: 1 });
  }
}

function turnAlignAllOff(hold: SnapHold): void {
  const meta = hold.alignAll!;
  // 다음 켜기도 같은 나누기로 — 캡슐이 가리키는 전역 기억도 함께 둔다.
  setAlignLayout(meta.layout);
  const assigned = new Set(Object.keys(hold.assignments));
  const operations = { ...state.operations };
  let freshIndex = Object.keys(operations).length;
  for (const sessionId of assigned) {
    const current = operations[sessionId];
    if (!current) continue;
    const saved = meta.savedGeometries[sessionId];
    // 켠 뒤 들어온 패널은 기억된 자리가 없다 — 처음 생성될 때 받았을 기본 자리로 보낸다.
    operations[sessionId] = saved
      ? { ...saved, zIndex: current.zIndex }
      : {
          x: freshIndex * DEFAULT_OPERATION_OFFSET,
          y: freshIndex * DEFAULT_OPERATION_OFFSET,
          width: DEFAULT_OPERATION_WIDTH,
          height: DEFAULT_OPERATION_HEIGHT,
          zIndex: claimTopZIndex(),
        };
    freshIndex += 1;
  }
  // 켜기 전 수동 묶음 복원 — 없어졌거나 최소화된 패널은 빼고, 빈 묶음은 두지 않는다.
  let snapHold: SnapHold | null = null;
  if (meta.savedSnapHold) {
    const assignments = Object.fromEntries(Object.entries(meta.savedSnapHold.assignments)
      .filter(([sessionId]) => sessionId in operations && !state.minimized.includes(sessionId)));
    if (Object.keys(assignments).length > 0) {
      snapHold = { presetId: meta.savedSnapHold.presetId, zones: meta.savedSnapHold.zones, assignments };
    }
  }
  setState({ operations, snapHold });
}

/** 정렬 중 나누기 바꾸기 — 같은 나누기를 다시 누르면 무시한다. 끄는 길은 토글(Alt+F·캡슐·⌘K)이 소유한다. */
export function setAlignAllLayout(layout: AlignAllLayout): void {
  setAlignLayout(layout);
  const hold = state.snapHold;
  if (hold?.alignAll && hold.alignAll.layout !== layout) {
    setState({ snapHold: { ...hold, alignAll: { ...hold.alignAll, layout } } });
  }
}

/**
 * 묶음 멤버십·칸 재계산 — 렌더가 사이드바 순서의 보이는 id 목록을 들고 매번 부른다.
 * 빼낸(detached) 패널은 건너뛰고, 새로 보이게 된 패널은 순서 자리에 앉힌다.
 * 자리 교환은 사이드바 순서 교환으로 이미 반영되므로 여기서 덮어쓸 것이 없다.
 * 같으면 손대지 않아 렌더 effect와 발산하지 않는다.
 */
export function reconcileAlignAll(orderedIds: readonly string[]): void {
  const hold = state.snapHold;
  const meta = hold?.alignAll;
  if (!meta) return;
  const detached = new Set(meta.detached);
  const members = orderedIds.filter((sessionId) => !detached.has(sessionId));
  const zones = alignZonesFor(members.length, meta.layout);
  const assignments: Record<string, number> = {};
  members.forEach((sessionId, index) => { assignments[sessionId] = index; });
  if (snapZonesEqual(hold.zones, zones) && assignmentsEqual(hold.assignments, assignments)) return;
  setState({ snapHold: { ...hold, zones, assignments } });
}

/** 패널을 묶음에서 빼낸다 — 칸 밖 드롭. 나머지는 reconcile이 다시 나눈다. */
export function detachAlignAllPanel(sessionId: string): void {
  const hold = state.snapHold;
  if (!hold?.alignAll || !(sessionId in hold.assignments)) return;
  setState({ snapHold: detachAlignHold(hold, sessionId) });
}

function detachAlignHold(hold: SnapHold, sessionId: string): SnapHold {
  const meta = hold.alignAll!;
  const assignments = Object.fromEntries(Object.entries(hold.assignments).filter(([id]) => id !== sessionId));
  const detached = meta.detached.includes(sessionId) ? meta.detached : [...meta.detached, sessionId];
  return { ...hold, assignments, alignAll: { ...meta, detached } };
}

/** 빼낸 패널을 다시 넣는다 — 정렬 칸에 드롭. 자리는 사이드바 순서가 정한다. */
export function rejoinAlignAllPanel(sessionId: string): void {
  const hold = state.snapHold;
  if (!hold?.alignAll || !hold.alignAll.detached.includes(sessionId)) return;
  setState({
    snapHold: { ...hold, alignAll: { ...hold.alignAll, detached: hold.alignAll.detached.filter((id) => id !== sessionId) } },
  });
}

/**
 * 정렬 해제 — 켜기 전 자리 복원 없이 그 자리에 남긴다. 줌·fit-all·Station Keeping 진입 같은
 * "카메라·규율을 움직이려는 의도"가 부른다. 명시적 끄기(토글)는 turnAlignAllOff가 맡는다.
 */
export function releaseAlignAll(): void {
  if (state.snapHold?.alignAll) setState({ snapHold: null });
}

/**
 * 유지 없는 스냅 배치 — 정렬이 유지 슬롯을 소유한 동안 수동 스냅(캡션 메뉴·단축키)이 부른다.
 * 묶음에 든 패널이면 먼저 빼내고, 칸 자리에는 유지 없이 앉힌다. 정렬 자체는 계속된다.
 */
export function snapFreePanelToArenaRect(sessionId: string, bodyRect: CanvasWorldRect): void {
  const zIndex = claimTopZIndex();
  // 줌 100% 프레임 — 지금 아레나 좌상단이 가리키는 월드 점을 원점으로 칸을 1:1로 놓는다.
  const originX = -state.viewport.x / state.viewport.zoom;
  const originY = -state.viewport.y / state.viewport.zoom;
  const world = { x: originX + bodyRect.x, y: originY + bodyRect.y, width: bodyRect.width, height: bodyRect.height, zIndex };
  let snapHold = state.snapHold;
  if (snapHold?.alignAll && sessionId in snapHold.assignments) snapHold = detachAlignHold(snapHold, sessionId);
  setState({
    operations: { ...state.operations, [sessionId]: { ...normalizeOperationGeometry(world, zIndex), zIndex } },
    minimized: state.minimized.includes(sessionId) ? state.minimized.filter((id) => id !== sessionId) : state.minimized,
    snapHold,
  });
  if (Math.abs(state.viewport.zoom - 1) > ZOOM_TWEEN_ZOOM_EPSILON || Math.abs(state.viewport.x + originX) > ZOOM_TWEEN_POSITION_EPSILON || Math.abs(state.viewport.y + originY) > ZOOM_TWEEN_POSITION_EPSILON) {
    animateViewportTo({ x: -originX, y: -originY, zoom: 1 });
  }
}

function assignmentsEqual(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) return false;
  return leftEntries.every(([sessionId, index]) => right[sessionId] === index);
}

// 꺼져 있을 때 캡슐이 가리키는 나누기 — 켜져 있는 동안 유지 묶음 안의 layout이 진실이라 둘은 같이 간다.
function setAlignLayout(layout: AlignAllLayout): void {
  if (alignLayout === layout) return;
  alignLayout = layout;
  writeStoredAlignLayout(layout);
  emitAlignLayout();
}

function snapHoldWithout(hold: SnapHold | null, sessionIds: readonly string[]): SnapHold | null {  if (!hold) return null;
  const drop = sessionIds.filter((id) => id in hold.assignments);
  if (drop.length === 0) return hold;
  const assignments = Object.fromEntries(Object.entries(hold.assignments).filter(([id]) => !drop.includes(id)));
  return Object.keys(assignments).length === 0 ? null : { ...hold, assignments };
}

function snapZonesEqual(left: readonly SnapZoneFraction[], right: readonly SnapZoneFraction[]): boolean {
  return left.length === right.length && left.every((zone, index) => zone.every((value, k) => Math.abs(value - right[index]![k]!) < 0.0001));
}

// 규율이 켜진 상태의 불변식 복구 — War Room 지도 이동처럼 규율 밖 쓰기가 남긴 겹침을 정착시킨다.
export function enforceStationKeeping(): void {
  if (!state.stationKeeping) return;
  const spread = spreadVisibleOperations(state.operations, hiddenGeometryIds());
  if (spread) setState({ operations: spread });
}

// 단일 패널 정착(드래그·리사이즈 해제) — 만진 패널만 움직이고 이웃은 절대 움직이지 않는다.
export function settleOperationGeometry(sessionId: string): void {
  if (!state.stationKeeping) return;
  const geometry = state.operations[sessionId];
  if (!geometry || hiddenGeometryIds().has(sessionId)) return;
  const spot = resolveStationKeepingPosition(geometry, visibleObstacles(sessionId));
  if (spot.x === geometry.x && spot.y === geometry.y) return;
  setState({ operations: { ...state.operations, [sessionId]: { ...geometry, x: spot.x, y: spot.y } } });
}

// 생성 좌표 정착 — 규율은 Theater별 상태이므로 대상 Theater의 스냅샷을 따른다.
// 비활성 Theater(War Room 소유 영역 실행)는 저장된 스냅샷 기준으로 정착해 다음 방문 때 겹치지 않는다.
export function resolveLaunchGeometry(theaterId: string, geometry: OperationGeometry): OperationGeometry {
  const snapshot = activeTheaterId === theaterId ? state : readStoredState(theaterId);
  if (!snapshot.stationKeeping) return geometry;
  // 최소화한 지휘관의 숨은 단계는 장애물이 아니다 — 보이는 빈자리를 두고 새 패널이 밀려나면 안 된다.
  const minimizedSet = hiddenGeometryIds(snapshot.minimized);
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
  const operationAccent = Object.fromEntries(Object.entries(state.operationAccent).filter(([sessionId]) => valid.has(sessionId)));
  const accentChanged = Object.keys(operationAccent).length !== Object.keys(state.operationAccent).length;
  const maximizedOperationId = getMaximizedOperationId();
  const companionOperationId = getCompanionOperationId();
  if (maximizedOperationId && (!valid.has(maximizedOperationId) || minimized.includes(maximizedOperationId))) clearMaximizedOperationId();
  // companion은 목록 부재만으로 즉시 정리하지 않는다 — ops 푸시 레이스로 일시 부재가 흔하며,
  // 지속 부재의 정리는 캔버스 렌더 측 유예 효과가 소유한다. 최소화는 사용자 확정 액션이라 즉시 닫는다.
  if (companionOperationId && minimized.includes(companionOperationId)) forceDropCompanionOperationId();
  const prunedIds = Object.keys(state.snapHold?.assignments ?? {}).filter((sessionId) => !valid.has(sessionId));
  let snapHold = snapHoldWithout(state.snapHold, prunedIds);
  // 닫힌 패널의 자취를 정렬 기억에서도 걷는다 — 켜기 전 자리·빼낸 목록·복원 묶음에 유령 id가 남지 않게 한다.
  if (snapHold?.alignAll) {
    const meta = snapHold.alignAll;
    const savedGeometries = Object.fromEntries(Object.entries(meta.savedGeometries).filter(([sessionId]) => valid.has(sessionId)));
    const detached = meta.detached.filter((sessionId) => valid.has(sessionId));
    let savedSnapHold = meta.savedSnapHold;
    if (savedSnapHold) {
      const assignments = Object.fromEntries(Object.entries(savedSnapHold.assignments).filter(([sessionId]) => valid.has(sessionId)));
      savedSnapHold = Object.keys(assignments).length > 0 ? { ...savedSnapHold, assignments } : null;
    }
    if (Object.keys(savedGeometries).length !== Object.keys(meta.savedGeometries).length
      || detached.length !== meta.detached.length
      || savedSnapHold !== meta.savedSnapHold) {
      snapHold = { ...snapHold, alignAll: { ...meta, savedGeometries, detached, savedSnapHold } };
    }
  }
  if (changed || minimizedChanged || accentChanged || snapHold !== state.snapHold) {
    setState({ operations, minimized, operationAccent, snapHold });
  }
}

export function loadForTheater(theaterId: string | null): void {
  flushScheduledSave();
  cancelZoomTween();
  saveFocusLayerForActiveTheater();
  activeTheaterId = theaterId;
  state = theaterId ? readStoredState(theaterId) : EMPTY_STATE;
  // 유지는 줌 100%의 것이다 — 다른 줌으로 저장된 상태(구버전·손상)면 자유 배치로 떨어진다.
  if (state.snapHold && Math.abs(state.viewport.zoom - 1) > ZOOM_TWEEN_ZOOM_EPSILON) state = { ...state, snapHold: null };
  // maximize와 companion은 상호 배타적인 focus layer다. Theater별 단일 상태로 보존·복원해
  // 같은 Theater가 다시 로드돼도 현재 레이아웃 모드와 대상 Operation을 함께 유지한다.
  const nextFocusLayer = theaterId ? focusLayersByTheater.get(theaterId) ?? null : null;
  const focusLayerChanged = !focusLayersEqual(focusLayer, nextFocusLayer);
  focusLayer = nextFocusLayer;
  // 모두 정렬은 Theater별 CanvasState(유지 묶음)에 살아 Theater를 다녀와도 이어진다 — 별도 복원이 없다.
  targetViewport = state.viewport;
  // 복원된 Operation의 최대 zIndex 위로 카운터를 끌어올린다 — 새로고침/Theater 전환 후에도 활성화→최상단을 보장한다.
  topZIndex = Math.max(topZIndex, maxZIndexOf(state.operations));
  // 규율이 켜진 Theater는 로드 시점에 불변식을 복구한다 — 비활성 상태에서 들어온 규율 밖 쓰기
  // (War Room 지도 이동 등)가 남긴 겹침을 정착시키고, 복구를 저장까지 수렴시켜 다음 로드가
  // 같은 복구를 반복하지 않게 한다(이탈 시 flushScheduledSave가 이 상태를 쓴다).
  if (state.stationKeeping) {
    const spread = spreadVisibleOperations(state.operations, hiddenGeometryIds());
    if (spread) {
      state = { ...state, operations: spread };
      scheduleSave();
    }
  }
  emit();
  if (focusLayerChanged) emitFocusLayer();
}

// 포커스(사이드바·검색 점프·Alt+화살표)는 카메라를 패널로 보내지 않고 패널을 지금 보는 화면으로 부른다.
// 이미 아레나 안에 온전히 보이면 자리를 건드리지 않고 최상단으로만 올린다. 보이지 않으면 크기는 그대로
// 두고 현재 줌에서 아레나 가운데에 앉힌다 — 아레나보다 크면 왼쪽 위를 모드 프레임 여백에 맞춘다.
//
// 두 예외는 카메라 쪽이 맞다. Fleet Map(줌이 판독 한계 아래)에서 점을 고른 것은 "그 패널로 내려가자"라
// 지도 위에서 좌표만 옮기면 아무 일도 안 일어난 것처럼 보이므로, 예전처럼 패널을 향해 줌인한다.
// 최대화·companion은 저장된 Cruise 좌표를 렌더에서 덮고 있을 뿐이라 보이지 않는 뷰포트를
// 기준으로 좌표를 고쳐 쓰면 Cruise로 돌아왔을 때 손으로 놓은 자리가 사라진다 — 활성화·복원만 한다.
export function focusOperation(sessionId: string, viewportSize: CanvasViewportSize): void {
  const geometry = state.operations[sessionId];
  if (!geometry) return;
  const zIndex = claimTopZIndex();
  const wasMinimized = state.minimized.includes(sessionId);
  const unminimize = wasMinimized ? { minimized: state.minimized.filter((id) => id !== sessionId) } : {};
  // 최대화·companion은 Cruise 좌표와 카메라를 렌더에서 덮고 있을 뿐이다 — 숨은 뷰포트도 기하도
  // 건드리지 않고 활성화·복원만 한다. 돌아왔을 때 떠난 그대로의 Cruise가 있어야 한다.
  const projected = focusLayer !== null;
  if (!projected && state.viewport.zoom < FOCUS_READABLE_ZOOM) {
    const zoom = Math.max(FOCUS_READABLE_ZOOM, Math.min(FOCUS_MAX_ZOOM, Math.min(
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
    setState({
      viewport: focusedViewport,
      operations: { ...state.operations, [sessionId]: { ...normalizeOperationGeometry(geometry, zIndex), zIndex } },
      ...unminimize,
    });
    return;
  }
  let next = geometry;
  let followViewport: CanvasViewport | null = null;
  if (!projected) {
    const arena = getCanvasArenaRect() ?? { x: 0, y: 0, width: viewportSize.width, height: viewportSize.height };
    const zoom = state.viewport.zoom;
    const frame = {
      x: geometry.x * zoom + state.viewport.x,
      y: (geometry.y - OPERATION_WINDOW_CAPTION_HEIGHT) * zoom + state.viewport.y,
      width: geometry.width * zoom,
      height: (geometry.height + OPERATION_WINDOW_CAPTION_HEIGHT) * zoom,
    };
    const visible = frame.x >= 0 && frame.y >= 0 && frame.x + frame.width <= arena.width && frame.y + frame.height <= arena.height;
    if (!visible) {
      const inset = FOCUS_BRING_IN_INSET;
      const screenX = frame.width + inset * 2 <= arena.width ? (arena.width - frame.width) / 2 : inset;
      const screenY = frame.height + inset * 2 <= arena.height ? (arena.height - frame.height) / 2 : inset;
      next = {
        ...geometry,
        x: (screenX - state.viewport.x) / zoom,
        y: (screenY - state.viewport.y) / zoom + OPERATION_WINDOW_CAPTION_HEIGHT,
      };
      // 규율이 켜져 있으면 불러온 자리도 정착시킨다 — 가운데에 이미 다른 패널이 있으면 겹친 채 서지 않는다.
      // 정착이 패널을 아레나 밖으로 밀어냈다면 카메라가 그만큼만 따라간다 — 불러온 패널이 안 보이면
      // 포커스가 아무 일도 안 한 것이 되고, 겹치게 두면 규율이 깨진다.
      if (state.stationKeeping) {
        const spot = resolveStationKeepingPosition(next, visibleObstacles(sessionId));
        next = { ...next, x: spot.x, y: spot.y };
        const settled = {
          x: next.x * zoom + state.viewport.x,
          y: (next.y - OPERATION_WINDOW_CAPTION_HEIGHT) * zoom + state.viewport.y,
          width: frame.width,
          height: frame.height,
        };
        const dx = settled.x < 0 ? -settled.x : settled.x + settled.width > arena.width ? arena.width - settled.x - settled.width : 0;
        const dy = settled.y < 0 ? -settled.y : settled.y + settled.height > arena.height ? arena.height - settled.y - settled.height : 0;
        if (dx !== 0 || dy !== 0) followViewport = { x: state.viewport.x + dx, y: state.viewport.y + dy, zoom };
      }
    }
  }
  setState({
    operations: { ...state.operations, [sessionId]: { ...normalizeOperationGeometry(next, zIndex), zIndex } },
    ...unminimize,
  });
  if (followViewport) animateViewportTo(followViewport);
}

export function setMaximizedOperationId(operationId: string): void {
  const nextFocusLayer = { mode: "maximized", operationId } as const;
  if (activeTheaterId) focusLayersByTheater.set(activeTheaterId, nextFocusLayer);
  // 최대화는 underlay(Map 또는 스냅 유지)를 바꾸지 않는 렌더 전용 포커스 레이어다.
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

function subscribeAlignLayout(listener: Listener): () => void {
  alignLayoutListeners.add(listener);
  return () => {
    alignLayoutListeners.delete(listener);
  };
}

/** 모두 정렬 진입 직전 훅 — 선별 중이면 War Room을 먼저 끝낸다. 단일 리스너(마지막 등록이 이긴다). */
export function registerBeforeAlignAllActivation(listener: (theaterId: string) => void): void {
  beforeAlignAllActivation = listener;
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

function emitAlignLayout(): void {
  for (const listener of alignLayoutListeners) listener();
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
    // 서버 이관이 끝나기 전의 캔버스 저장이 옛 순서를 지우지 않도록 원본 필드만 잠시 보존한다.
    const existing = window.localStorage.getItem(storageKey(theaterId));
    let legacyOrder: unknown;
    try {
      const parsed: unknown = existing ? JSON.parse(existing) : null;
      if (isRecord(parsed)) legacyOrder = parsed.operationOrder;
    } catch { /* 손상된 저장값은 캔버스 상태로 교체한다. */ }
    window.localStorage.setItem(storageKey(theaterId), JSON.stringify({ ...value, ...(legacyOrder !== undefined ? { operationOrder: legacyOrder } : {}) }));
  } catch {
    // 저장 실패는 캔버스 복구성만 낮추므로 런타임 흐름을 막지 않는다.
  }
}

function readStoredAlignLayout(): AlignAllLayout {
  if (typeof window === "undefined") return "grid";
  try {
    const stored = window.localStorage.getItem(ALIGN_ALL_LAYOUT_STORAGE_KEY);
    if (stored === "columns" || stored === "rows" || stored === "grid") return stored;
    // 퇴역한 formation-layout 키는 한 번만 이관한다 — 사용자 선택을 살리고 그 키는 지운다.
    // 즉시 삭제하는 이유: 죽은 키가 남으면 다음 구현이 "살아 있는 계약"으로 오해하고,
    // 유예해도 읽을 일이 다시는 없으므로 잔류는 혼란만 남긴다.
    const legacy = window.localStorage.getItem(LEGACY_FORMATION_LAYOUT_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_FORMATION_LAYOUT_STORAGE_KEY);
    if (legacy === "columns" || legacy === "rows" || legacy === "grid") {
      window.localStorage.setItem(ALIGN_ALL_LAYOUT_STORAGE_KEY, legacy);
      return legacy;
    }
    return "grid";
  } catch {
    return "grid";
  }
}

function writeStoredAlignLayout(layout: AlignAllLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ALIGN_ALL_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // 저장 실패는 나누기 기억만 잃으므로 런타임 흐름을 막지 않는다.
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
    operationAccent: normalizeOperationAccent(value.operationAccent),
    minimized: normalizeMinimized(value.minimized),
    collapsedGroups: normalizeStringArray(value.collapsedGroups),
    stationKeeping: value.stationKeeping === true,
    snapHold: normalizeSnapHold(value.snapHold, operations),
  };
}

function normalizeSnapHold(value: unknown, operations: Record<string, OperationGeometry>, allowAlignAll = true): SnapHold | null {
  if (!isRecord(value) || typeof value.presetId !== "string" || !Array.isArray(value.zones) || !isRecord(value.assignments)) return null;
  const zones: SnapZoneFraction[] = [];
  for (const zone of value.zones) {
    if (!Array.isArray(zone) || zone.length !== 4 || !zone.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) return null;
    zones.push([zone[0], zone[1], zone[2], zone[3]]);
  }
  const assignments: Record<string, number> = {};
  for (const [id, index] of Object.entries(value.assignments)) {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= zones.length || !(id in operations)) continue;
    assignments[id] = index;
  }
  // 모두 정렬은 칸이 비어도 묶음으로 산다 — 멤버십은 렌더의 reconcile이 다시 채운다.
  const alignAll = allowAlignAll ? normalizeAlignAll(value.alignAll, operations) : null;
  if (alignAll) return { presetId: value.presetId, zones, assignments, alignAll };
  if (zones.length === 0 || Object.keys(assignments).length === 0) return null;
  return { presetId: value.presetId, zones, assignments };
}

function normalizeAlignAll(value: unknown, operations: Record<string, OperationGeometry>): AlignAllMeta | null {
  if (!isRecord(value)) return null;
  const layout = value.layout;
  if (layout !== "grid" && layout !== "columns" && layout !== "rows") return null;
  const savedGeometries: Record<string, OperationGeometry> = {};
  if (isRecord(value.savedGeometries)) {
    for (const [sessionId, geometry] of Object.entries(value.savedGeometries)) {
      savedGeometries[sessionId] = normalizeOperationGeometry(geometry, 0);
    }
  }
  // 켜기 전 수동 묶음은 중첩 정렬을 갖지 않는다 — 있어도 무시한다.
  const savedSnapHold = normalizeSnapHold(value.savedSnapHold, operations, false);
  const detached = Array.isArray(value.detached)
    ? value.detached.filter((sessionId): sessionId is string => typeof sessionId === "string")
    : [];
  return { layout, savedGeometries, savedSnapHold, detached };
}

// 서버 order가 아직 없는 Theater에서만 호출되는 구 브라우저 순서의 이관 전용 읽기다.
export function readLegacyOperationOrder(theaterId: string): readonly string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(theaterId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? normalizeOperationOrder(parsed.operationOrder) : [];
  } catch {
    return [];
  }
}

export function clearLegacyOperationOrder(theaterId: string): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(storageKey(theaterId));
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !("operationOrder" in parsed)) return;
    delete parsed.operationOrder;
    // 활성 Theater의 지연 저장도 순서를 포함하지 않아 다시 생겨나지 않는다.
    window.localStorage.setItem(storageKey(theaterId), JSON.stringify(parsed));
  } catch {
    // 브라우저 저장소를 쓸 수 없으면 다음 수화에서 다시 시도한다.
  }
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
