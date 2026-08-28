import type { OperationActivityVisual } from "../operation-activity.js";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OperationRuntimeState, CompanionPanelDescriptor, ConsoleTheme, FleetClientPlugin, OperationKindDescriptor, OperationRenderContext } from "@fleet-console/sdk/plugin";

import { fetchOperations } from "../api.js";
import { availableCompanionPanels, isBlockingDialogOpen } from "../shortcuts.js";
import { clearActiveOperation, isWarRoomEmptyReleaseTarget } from "../active-operation-surface.js";
import { flattenGroupedOrder, focusCycleOperationIds, hydrateOperations, requestOperationKeyboardFocus, requestOperationLaunchMenu, resolveOperationGroup, setActiveOperation } from "../store.js";
import { createHostCapabilities } from "../plugin-capabilities.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { useGlobalSettingsStore } from "../global-settings-store.js";
import { useT } from "../i18n/index.js";
import { clearIdleArrival, getIdleArrivalIds, subscribeIdleArrival } from "../operation-marks.js";
import { pluginRuntimeState, resolveOperationActivity } from "../operation-activity.js";
import type { ConsoleState, OperationNode } from "../types.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";
import { OperationBodySlot, useOperationBodyPoolAvailable, type OperationBodyConfig } from "../mobile/operation-body-pool.js";
import { calculateGridSlots, animateViewportTo, claimTopZIndex, clearCompanionOperationId, clearMaximizedOperationId, consumePendingFitAllOperations, enforceStationKeeping, focusOperation, forceDropCompanionOperationId, getSnapshot as getCanvasSnapshot, getTheaterCanvasSnapshot, getTheaterMinimizedIds, minimizeOperation, OPERATION_WINDOW_CAPTION_HEIGHT, prefersReducedMotion, resetCanvasViewportSize, restoreOperation, setCanvasViewportSize, setCompanionOperationId, setCompanionPanelVisible, setMaximizedOperationId, setOperationGeometry, setTheaterOperationGeometry, setTheaterOperationMinimized, settleOperationGeometry, setViewport, useCanvasState, useCompanionOperationId, useCompanionPanelVisibilityOverrides, useFormationLayout, useFormationView, useMaximizedOperationId, useMinimized, type OperationGeometry } from "./canvas-store.js";
import { escapeSelectorValue, flyPanelMotionGhost, playMinimizeFlight } from "./panel-motion.js";
import { CanvasContextMenu } from "./canvas-context-menu.js";
import { CanvasMinimap } from "./canvas-minimap.js";
import { resolveAccentColor } from "./operation-accent.js";
import { CanvasGrid, RubberBand, TriageClearPlate } from "./canvas-overlays.js";
import { flashTriageDeckCard, getTriageDeckCardRect, resolveTriageDeckPromotion, takeTriageDeckDepartureRect, TriageWatchDeck, useTriageDeckZoomControl, type TriageDeckArrivalDwell } from "./triage-watch-deck.js";
import { resolveGlanceHudModel, type GlanceHudModel } from "./glance-hud.js";
import { OperationFrame } from "./operation-frame.js";
import { hasVisibleCanvasContent, OperationsCanvasEmptyState } from "./operations-canvas-empty-state.js";
import { useCanvasInteraction } from "./use-canvas-interaction.js";
import { modeSlotGeometryFor, operationWindowFrameFor, screenToCanvas, triageStageGeometryFor, type CanvasPoint, type CanvasRect } from "./coordinates.js";
import { disarmTriageSetAside, dismissTriageOperation, forgetTriageOperation, getTriageEnteredAt, getTriagePick, getTriageSetAsideArmedId, getTriageSnapshot, isTriageActive, isTriageClearedTransition, isTriageOperationDeferred, isTriageOperationDismissed, isTriageWaitingOperation, pickTriageOperation, reconcileTriageStageCompanion, recordTriageStageTheater, resolveActiveAwaitingTriageEntry, resolveTriageQueue, scheduleTriageClear, subscribeTriage, useTriageActive, useTriageSpotlightEnabled, type TriageQueueEntry, type TriageStageIdentity } from "./triage-store.js";

interface OperationsCanvasProps {
  readonly state: ConsoleState;
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly canLaunch: boolean;
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind, canvasPoint: CanvasPoint, theaterId?: string, variant?: Readonly<Record<string, string>>) => void;
  readonly onLaunchAtGeometry: (pluginId: string, kind: OperationLaunchKind, geometry: OperationGeometry) => void;
  readonly onRefreshCatalog?: () => void;
  readonly onClose: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  /** 빈 캔버스의 일괄 열기 — 대기 목록에 보인 순서(updatedAt 내림차순) 그대로 id를 넘긴다. */
  readonly onOpenAll: (operationIds: readonly string[]) => void;
  readonly onRename: (operationId: string, title: string) => void;
  readonly onOpenOperationMenu?: (operationId: string, anchor: DOMRect, returnFocus?: HTMLElement | null) => void;
  /** 그 Operation의 패널이 focus layer 뒤로 숨었다 — 그 패널이 주인인 메뉴가 열려 있으면 거둔다. */
  readonly onDismissOperationMenu?: (operationId: string) => void;
}

interface ContextMenuRequest {
  readonly anchor: CanvasPoint;
  readonly canvasPoint: CanvasPoint;
  readonly theaterId?: string;
}

interface PluginOperationRendererProps {
  readonly active: boolean;
  readonly keyboardFocusRequestId?: number;
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly geometry: OperationGeometry;
  readonly operation: OperationNode;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly viewportZoom: number;
  readonly runtimeState: OperationRuntimeState | null;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  readonly onRequestCompanions: (open: boolean) => void;
  readonly companionsOpen: boolean;
  readonly hiddenCompanionPanelIds: readonly string[];
  readonly onSetCompanionPanelVisible: (companionPanelId: string, visible: boolean) => void;
  readonly bodyLive?: boolean;
  readonly render: (context: OperationRenderContext) => unknown;
}

const DEFAULT_SHELL_WIDTH = 560;
const DEFAULT_SHELL_HEIGHT = 360;
/* components.css의 .canvas-operation-titlebar top(-32px)과 짝을 이루는 상수.
   캡션은 본문·PTY geometry 밖에 붙는 패널 속성이라, 이 높이만큼만 캔버스 클립을 본다.
   행 보폭은 calculateGridSlots가 같은 상수를 쓴다. */
const TITLEBAR_OUTSET_PX = OPERATION_WINDOW_CAPTION_HEIGHT;
// 프리뷰 config는 identity 비교로 재발행이 억제되므로 공유 불변 배열을 쓴다.
const EMPTY_HIDDEN_COMPANION_IDS: readonly string[] = [];

export function OperationsCanvas({
  state,
  catalog,
  canLaunch,
  renderKindIcon,
  onLaunchKind,
  onLaunchAtGeometry,
  onRefreshCatalog,
  onClose,
  onFocus,
  onOpenAll,
  onRename,
  onOpenOperationMenu,
  onDismissOperationMenu,
}: OperationsCanvasProps) {
  const canvasRef = useRef<HTMLElement | null>(null);
  const t = useT();
  const canvas = useCanvasState();
  const formationLayout = useFormationLayout();
  const formationView = useFormationView();
  const maximizedOperationId = useMaximizedOperationId();
  const companionOperationId = useCompanionOperationId();
  const companionPanelVisibilityOverrides = useCompanionPanelVisibilityOverrides(companionOperationId);
  const lastValidCompanionRef = useRef<{ readonly operation: OperationNode; readonly descriptor: OperationKindDescriptor } | null>(null);
  const minimized = useMinimized();
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const activePluginOperationId = state.activeOperationId;
  const [contextMenu, setContextMenu] = useState<ContextMenuRequest | null>(null);
  const registry = usePluginRegistry();
  const globalSettings = useGlobalSettingsStore();
  const language = resolveConsoleLanguage(globalSettings.state?.language ?? "auto");
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const glanceVisible = useGlanceHold();
  const disabled = !state.activeTheaterId || state.addingTheater;
  const operationBodyPoolAvailable = useOperationBodyPoolAvailable();
  const triageActive = useTriageActive();
  const triageSpotlightEnabled = useTriageSpotlightEnabled();
  useSyncExternalStore(subscribeTriage, getTriageSnapshot, getTriageSnapshot);
  const triageDeckZoom = useTriageDeckZoomControl();
  const [triageEntering, setTriageEntering] = useState(false);
  const [, setTriageDeckDwellRevision] = useState(0);
  const [formationEntering, setFormationEntering] = useState(false);
  const [cruiseEntering, setCruiseEntering] = useState(false);
  const previousCanvasModeRef = useRef<"cruise" | "tactical" | "warRoom" | null>(null);
  const [, setTriageFocusRevision] = useState(0);
  const previousTriageStageRef = useRef<string | null>(null);
  const previousTriageDeckStageRef = useRef<string | null>(null);
  const triageDeckArrivalDwellRef = useRef<TriageDeckArrivalDwell | null>(null);
  const triageStageRectRef = useRef(new Map<string, DOMRect>());
  const triageStageActivityRef = useRef<{
    readonly operationId: string;
    readonly activity: OperationActivityVisual;
  } | null>(null);
  const pendingTriageClearRef = useRef<{
    readonly operationId: string;
    readonly cancel: () => void;
  } | null>(null);
  const autoFocusedTriageStageRef = useRef<TriageStageIdentity | null>(null);
  const companionTriageStageRef = useRef<TriageStageIdentity | null>(null);
  const triageRuntimeRef = useRef<{
    readonly operations: readonly OperationNode[];
    readonly operationRuntime: Readonly<Record<string, OperationRuntimeState>>;
  }>({ operations: [], operationRuntime: {} });

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = (consumePending: boolean) => {
      const viewportSize = { width: element.clientWidth, height: element.clientHeight };
      setCanvasSize(viewportSize);
      setCanvasViewportSize(viewportSize);
      if (consumePending) consumePendingFitAllOperations();
    };
    update(false);
    const observer = new ResizeObserver(() => update(true));
    observer.observe(element);
    return () => {
      observer.disconnect();
      resetCanvasViewportSize();
    };
  }, []);

  useEffect(() => {
    if (!triageActive) {
      setTriageEntering(false);
      return;
    }
    // 커튼은 전역 진입 시각 기준으로 한 번만 친다 — 선별 중 Theater 자동 전환은 재생하지 않는다.
    const enteredAt = getTriageEnteredAt() ?? Date.now();
    const remaining = Math.max(0, 1_900 - (Date.now() - enteredAt));
    setTriageEntering(remaining > 0);
    if (remaining === 0) return;
    const timer = window.setTimeout(() => setTriageEntering(false), remaining);
    return () => window.clearTimeout(timer);
  }, [triageActive]);

  useEffect(() => {
    if (!triageActive) return;
    const rerender = () => setTriageFocusRevision((value) => value + 1);
    document.addEventListener("focusin", rerender);
    document.addEventListener("focusout", rerender);
    return () => {
      document.removeEventListener("focusin", rerender);
      document.removeEventListener("focusout", rerender);
    };
  }, [triageActive]);

  useEffect(() => {
    if (!formationView || !state.activeTheaterId) {
      setFormationEntering(false);
      return;
    }
    setFormationEntering(true);
    // 커튼 1400ms → 타일 착지 1180ms + stagger 40ms×n + 420ms. 9패널 기준 1920ms에 끝난다.
    const timer = window.setTimeout(() => {
      setFormationEntering(false);
    }, 1_950);
    return () => window.clearTimeout(timer);
  }, [formationView, state.activeTheaterId]);

  // 모드 이탈도 진입과 같은 무게로 알린다 — Cruise 복귀 역시 커튼 한 장으로 도착을 선언한다.
  useEffect(() => {
    const mode = triageActive ? "warRoom" : formationView ? "tactical" : "cruise";
    const previousMode = previousCanvasModeRef.current;
    previousCanvasModeRef.current = mode;
    if (mode !== "cruise") {
      // Tactical↔War Room 직접 전환은 그 모드의 커튼이 소유한다 — 남은 복귀 커튼을 즉시 걷는다.
      setCruiseEntering(false);
      return;
    }
    // 첫 마운트가 Cruise인 것은 복귀가 아니다.
    if (previousMode === null || previousMode === "cruise") return;
    // Station Keeping이 켜져 있으면 모드 밖에서 생긴 겹침(War Room 지도 이동 등)을 복귀 시점에 정착시킨다.
    enforceStationKeeping();
    setCruiseEntering(true);
    const timer = window.setTimeout(() => setCruiseEntering(false), 1_400);
    return () => window.clearTimeout(timer);
  }, [formationView, triageActive]);

  // 포커스 레이어(최대화·companion)가 걷힌 순간 Cruise 규율을 재적용한다 — 드래그 도중 레이어 전환은
  // 드래그를 커밋 없이 중단시키므로(operation-frame의 interaction-disabled 정리), 라이브 좌표가 겹친 채
  // 남을 수 있다. 정착은 커밋에만 걸려 있어 이 재적용이 그 구멍을 막는다. 규율이 꺼져 있으면 no-op.
  const focusLayerActive = maximizedOperationId !== null || companionOperationId !== null;
  useEffect(() => {
    if (focusLayerActive || formationView || triageActive) return;
    enforceStationKeeping();
  }, [focusLayerActive, formationView, triageActive]);

  const interaction = useCanvasInteraction({
    viewport: canvas.viewport,
    // Formation은 읽기 전용 감독 그리드다 — 슬롯 사이 빈 공간에서 숨은 viewport를 팬/줌하거나
    // 오래된 월드 좌표로 생성하는 일이 없도록 캔버스 제스처를 통째로 게이트한다.
    disabled: disabled || formationView || companionOperationId !== null || triageActive,
    onViewportChange: setViewport,
    onZoom: animateViewportTo,
    onCreate: (rect) => {
      setContextMenu(null);
      if (state.activeTheaterId && canLaunch) {
        const target = resolveDefaultLaunchTarget(catalog);
        if (!target) return;
        const geometry = { ...rectToGeometry(rect), zIndex: claimTopZIndex() };
        onLaunchAtGeometry(target.pluginId, target.kind, geometry);
      }
    },
    consumePointerDown: contextMenu !== null,
    onConsumePointerDown: () => { setContextMenu(null); },
    // 빈 바다 클릭은 패널을 고르지 않은 것이다 — 터미널 키보드와 캡션 포커스(is-active)를 함께 걷는다.
    onClick: clearActiveOperation,
  });

  // 우클릭 가드는 다음 우클릭에서만 돈다. 마지막 Theater를 잊는 동안 이미 열린 상자는
  // 목록이 비워져도 그대로 남으므로, 그 전환에서 걷는다.
  useEffect(() => {
    if (state.theaters.length === 0) setContextMenu(null);
  }, [state.theaters.length]);

  const handleContextMenuLaunchKind = (
    pluginId: string,
    kind: OperationLaunchKind,
    variant?: Readonly<Record<string, string>>,
  ) => {
    const request = contextMenu;
    setContextMenu(null);
    if (!request) return;
    // War Room의 소유 영역 launch도 페이지가 소유한 기존 plugin launch 경로를 그대로 탄다.
    // theaterId가 없으면 Cruise의 활성 Theater 경로이고, 있으면 소유 영역이 명시한 Theater다.
    onLaunchKind(pluginId, kind, request.canvasPoint, request.theaterId, variant);
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    // 패널 안(터미널)은 어느 모드에서도 브라우저 메뉴가 필요하다 — 복사·붙여넣기가 거기 있다.
    if (target?.closest("[data-canvas-operation]")) return;
    // War Room에서는 캔버스 전체가 이 모드의 것이다. 자기 메뉴를 가진 표면(카드·점·밴드·구역·레일 행)은
    // 이미 stopPropagation으로 여기 닿지 않으므로, 여기 오는 것은 전부 "주인 없는 자리"다.
    // 그 자리도 캔버스 제어를 연다 — Theater를 소유한 표면(밴드 헤더·지도 구역)은 밀도 단계에 따라
    // 얇은 띠로 줄거나 통째로 사라지므로, 소유 표면에만 메뉴를 두면 실행 진입점이 밀도에 따라 없어진다.
    // 소유자가 없는 자리의 실행 대상은 활성 Theater이고, 어디로 실행되는지는 메뉴 헤더의 이름이 말한다.
    if (triageActive) {
      event.preventDefault();
      const activeTheaterId = state.activeTheaterId;
      if (!activeTheaterId) {
        setContextMenu(null);
        return;
      }
      openTriageTheaterLaunchMenu(activeTheaterId, { x: event.clientX, y: event.clientY });
      return;
    }
    if (target?.closest("[data-canvas-blocker]")) return;
    event.preventDefault();
    // 등록된 Theater가 없으면 실행할 대상이 없다 — 메뉴를 띄워도 고를 자리가 없으니
    // 브라우저 메뉴만 막고 우리 상자는 열지 않는다. War Room은 위에서 같은 이유로 막는다.
    if (state.theaters.length === 0) {
      setContextMenu(null);
      return;
    }
    const rect = canvasRef.current?.getBoundingClientRect();
    const anchor = rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null;
    if (!anchor) return;
    setContextMenu({ anchor, canvasPoint: screenToCanvas(anchor, canvas.viewport) });
    onRefreshCatalog?.();
  };

  const openTriageTheaterLaunchMenu = (theaterId: string, cursor: CanvasPoint) => {
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    if (!canvasRect) return;
    // 앵커와 클램프 경계는 같은 좌표계여야 한다 — 메뉴는 캔버스 크기로 클램프되므로 앵커도 캔버스-local이다.
    // position: fixed도 뷰포트에 걸리지 않는다: .operations-canvas의 contain: paint가 고정 위치의
    // 컨테이닝 블록이 되어 캔버스에 재앵커한다(실측). 뷰포트 좌표를 그대로 넘기면 메뉴가 커서에서
    // 캔버스 왼쪽 여백만큼 밀리고, 오른쪽 끝에서는 캔버스 폭으로 클램프돼 커서와 크게 어긋난다.
    const local = { x: cursor.x - canvasRect.left, y: cursor.y - canvasRect.top };
    setContextMenu({
      anchor: local,
      // 실행 좌표는 그 Theater의 world 좌표여야 한다 — canvasPointToGeometry는 받은 점을 world로
      // 취급한다. War Room은 전 Theater를 한 판에 얹으므로 화면-local을 그대로 넘기면 그 Theater를
      // 다시 열었을 때 패널이 보이는 자리 밖에 놓인다. 로드된 Theater가 아닐 수 있으니 저장된
      // 스냅샷의 뷰포트로 환산한다.
      canvasPoint: screenToCanvas(local, getTheaterCanvasSnapshot(theaterId).viewport),
      theaterId,
    });
    onRefreshCatalog?.();
  };

  const minimizedSet = new Set(minimized);
  // War Room의 판은 전 Theater를 한 번에 얹으므로 최소화 판정도 Theater 경계를 넘는다. canvas 스냅샷은
  // 비활성 Theater에 쓸 때도 새 객체로 갈리므로(setTheaterOperationMinimized) 이 파생값이 함께 갱신된다.
  const triageMinimizedSet = triageActive
    ? new Set(getTheaterMinimizedIds(state.theaters.map((theater) => theater.id)))
    : minimizedSet;
  const visibleOperations = Object.fromEntries(
    Object.entries(canvas.operations).filter(([sessionId]) => !minimizedSet.has(sessionId)),
  );
  const theaterOperations = (state.operations ?? []).filter((operation) => operation.theaterId === state.activeTheaterId);
  triageRuntimeRef.current = {
    operations: state.operations,
    operationRuntime: state.operationRuntime,
  };
  // 큐는 전역이다 — 활성 Theater와 무관하게 모든 대기 Operation을 처리 순서로 세운다.
  const triageQueue = resolveTriageQueue(state.operations, state.operationRuntime);
  const triageQueueIdSet = new Set(triageQueue.map((entry) => entry.operation.id));
  const triageIdleCount = state.operations.filter((operation) =>
    resolveOperationActivity(operation, state.operationRuntime) === "idle"
    && !triageQueueIdSet.has(operation.id)).length;
  const automaticTriageStage = triageQueue[0] ?? null;
  const previousTriageStageId = previousTriageStageRef.current;
  const previousTriageStageOperation = previousTriageStageId
    ? state.operations.find((operation) => operation.id === previousTriageStageId) ?? null
    : null;
  const previousTriageFrame = previousTriageStageId
    ? canvasRef.current?.querySelector<HTMLElement>(`.canvas-operation[data-operation-id="${escapeSelectorValue(previousTriageStageId)}"]`) ?? null
    : null;
  const previousTriageHasFocus = previousTriageFrame !== null
    && typeof document !== "undefined"
    && document.activeElement instanceof Node
    && previousTriageFrame.contains(document.activeElement)
    && !isTriageOperationDismissed(previousTriageStageId!);
  const previousTriageActivity = previousTriageStageOperation
    ? resolveOperationActivity(previousTriageStageOperation, state.operationRuntime)
    : null;
  const previousTriageStillWaiting = previousTriageStageOperation !== null
    && isTriageWaitingOperation(previousTriageStageOperation, state.operationRuntime);
  const previousStageTransitioning = previousTriageStageOperation !== null
    && triageStageActivityRef.current?.operationId === previousTriageStageOperation.id
    && previousTriageActivity !== null
    && isTriageClearedTransition(triageStageActivityRef.current.activity, previousTriageActivity);
  const pendingTriageOperationId = pendingTriageClearRef.current?.operationId ?? null;
  const graceTriageOperation = previousStageTransitioning
    ? previousTriageStageOperation
    : pendingTriageOperationId
      ? state.operations.find((operation) => operation.id === pendingTriageOperationId) ?? null
      : null;
  const graceTriageEntry: TriageQueueEntry | null = graceTriageOperation
    ? {
        operation: graceTriageOperation,
        activity: resolveOperationActivity(graceTriageOperation, state.operationRuntime),
        picked: getTriagePick() === graceTriageOperation.id,
      }
    : null;
  const protectedTriageEntry: TriageQueueEntry | null = previousTriageHasFocus && previousTriageStageOperation && previousTriageStillWaiting
    && !isTriageOperationDeferred(previousTriageStageOperation.id)
    ? {
        operation: previousTriageStageOperation,
        activity: previousTriageActivity!,
        picked: false,
      }
    : null;
  // 캡션으로만 활성화된 패널이 대기로 전이하면 무대 후보가 된다. pick이 아니라서 미룸·치워둠을
  // 풀지 않고, 스포트라이트 OFF 자동 등단도 강제하지 않는다. 명시적 지목·전이 유예·직전 무대
  // 포커스 고정이 이 클레임보다 앞선다.
  const activeAwaitingTriageEntry = resolveActiveAwaitingTriageEntry(state.operations, state.operationRuntime);
  // 최소화한 Operation은 판에서 내려간 것이므로 어떤 유지 경로로도 무대에 되살아나지 않는다.
  // previousTriageHasFocus가 치워둔 항목을 같은 이유로 이미 제외하지만, 최소화는 무대의 손잡이로
  // 실행되어 그 손잡이가 이전 프레임 안에서 포커스를 쥔 채 남는다 — 걸러내지 않으면 무대와 최소화
  // 선반에 같은 Operation이 동시에 선다. grace(전이 유예) 경로도 같은 이유로 함께 막는다.
  const retainedTriageCandidate = graceTriageEntry ?? protectedTriageEntry ?? activeAwaitingTriageEntry;
  const retainedTriageEntry = retainedTriageCandidate && triageMinimizedSet.has(retainedTriageCandidate.operation.id)
    ? null
    : retainedTriageCandidate;
  const pickedDifferentOperation = automaticTriageStage?.picked === true
    && automaticTriageStage.operation.id !== retainedTriageEntry?.operation.id;
  const triageDisplayQueue = retainedTriageEntry && !pickedDifferentOperation && automaticTriageStage?.operation.id !== retainedTriageEntry.operation.id
    ? [retainedTriageEntry, ...triageQueue.filter((entry) => entry.operation.id !== retainedTriageEntry.operation.id)]
    : triageQueue;
  const candidateTriageStage = triageActive ? triageDisplayQueue[0] ?? null : null;
  // 선별 처리의 관심사는 살아있는 함대다 — 휴면(dormant) Operation은 deck에 올리지 않는다.
  // 최소화한 Operation도 싣지 않는다: War Room에서 최소화는 "이 판에서 내린다"는 뜻이므로 deck이
  // 곧 그 판이다. 내려간 항목은 사이드바 최소화 선반에서 되올린다.
  const triageDeckOperations = triageActive
    ? state.operations.filter((operation) => resolveOperationActivity(operation, state.operationRuntime) !== "ended"
      && !triageMinimizedSet.has(operation.id))
    : theaterOperations;
  const triageDeckOperationIdSet = new Set(triageDeckOperations.map((operation) => operation.id));
  const deckWasVisible = triageActive
    && previousTriageDeckStageRef.current === null
    && triageDeckOperations.length > 0
    && !triageEntering;
  const deckPromotion = resolveTriageDeckPromotion({
    operationId: candidateTriageStage?.operation.id ?? null,
    picked: candidateTriageStage?.picked === true,
    deckVisible: deckWasVisible,
    spotlight: triageSpotlightEnabled,
    dwell: triageDeckArrivalDwellRef.current,
    now: Date.now(),
    suppressed: prefersReducedMotion(),
  });
  // 스포트라이트 OFF일 때 검토 전인 대기 카드에 지속 맥동을 얹는다 — 등단을 멈춘 대신 도착 신호는 남긴다.
  // 미룬(deferred) 항목은 레일 칩과 동일하게 제외한다 — 사용자가 이미 보고 미룬 신호를 다시 흔들지 않는다.
  const freshDeckOperationIds: ReadonlySet<string> = triageActive && !triageSpotlightEnabled
    ? new Set(triageQueue
        .filter((entry) => !entry.picked && !isTriageOperationDeferred(entry.operation.id))
        .map((entry) => entry.operation.id))
    : new Set();
  triageDeckArrivalDwellRef.current = deckPromotion.dwell;
  // 전 Theater가 마운트되므로 무대는 Theater 전환 없이 어느 소속이든 그대로 오른다.
  const triageStage = deckPromotion.promote ? candidateTriageStage : null;
  const triageStageId = triageStage?.operation.id ?? null;
  const triageStageTheaterId = triageStage?.operation.theaterId ?? null;
  useEffect(() => {
    // 종료 시 "마지막으로 무대에 올랐던 Theater"로 복귀하기 위한 이력 — 무대가 설 때만 기록한다.
    if (triageStageTheaterId !== null) recordTriageStageTheater(triageStageTheaterId);
  }, [triageStageTheaterId]);
  const triageDeckArrivingOperationId = deckPromotion.arrivingOperationId;
  useEffect(() => {
    const dwell = triageDeckArrivalDwellRef.current;
    if (!dwell || triageStageId !== null || prefersReducedMotion()) return;
    const remaining = Math.max(0, dwell.deadline - Date.now());
    if (remaining === 0) {
      setTriageDeckDwellRevision((revision) => revision + 1);
      return;
    }
    const timer = window.setTimeout(() => setTriageDeckDwellRevision((revision) => revision + 1), remaining);
    return () => window.clearTimeout(timer);
    // 스포트라이트 토글은 dwell ref를 후보 변경 없이 갱신한다(OFF=해제, ON 복귀=새 deadline) —
    // deps에 없으면 ON 복귀 시 새 deadline을 깨울 타이머가 스케줄되지 않아 등단이 멈춘다.
  }, [candidateTriageStage?.operation.id, candidateTriageStage?.picked, triageSpotlightEnabled, triageStageId]);
  // 덱의 칸은 그 Operation의 실제 패널이 서는 자리다 — 칸이 마운트되면 그 element를 기억하고,
  // 프레임 렌더가 거기로 portal한다. 화면 밖(무대·비선별)에서는 자리가 없으므로 프레임은 캔버스
  // 좌표에 그대로 선다. element identity가 바뀔 때만 state를 올려 렌더 루프를 만들지 않는다.
  const triageDeckSlotsRef = useRef(new Map<string, HTMLElement>());
  const [triageDeckSlots, setTriageDeckSlots] = useState<ReadonlyMap<string, HTMLElement>>(() => new Map());
  const registerTriageDeckSlot = useCallback((operationId: string, element: HTMLElement | null) => {
    const slots = triageDeckSlotsRef.current;
    if (element) {
      if (slots.get(operationId) === element) return;
      slots.set(operationId, element);
    } else if (!slots.delete(operationId)) return;
    setTriageDeckSlots(new Map(slots));
  }, []);
  const setAsideArmedId = getTriageSetAsideArmedId();
  // 덱 줌 wheel은 React 합성 onWheel 밖에서 부착한다 — React는 root wheel을 passive로
  // 묶어 preventDefault(브라우저 페이지 줌 차단)가 무용해진다. wheel 문법: bare wheel은
  // 덱 줌(캔버스와 동일), shift+wheel은 카드 격자 스크롤, alt는 건드리지 않는다.
  useEffect(() => {
    const canvasElement = canvasRef.current;
    if (!canvasElement) return;
    return triageDeckZoom.control.attachWheelListener(canvasElement);
  }, [triageDeckZoom.control]);
  useLayoutEffect(() => {
    if (!triageActive) {
      previousTriageDeckStageRef.current = null;
      triageStageRectRef.current.clear();
      return;
    }
    const previousStageId = previousTriageDeckStageRef.current;
    if (triageStageId) {
      const stage = canvasRef.current?.querySelector<HTMLElement>(`.canvas-operation[data-operation-id="${escapeSelectorValue(triageStageId)}"]`) ?? null;
      if (stage) triageStageRectRef.current.set(triageStageId, stage.getBoundingClientRect());
      if (previousStageId === null && !triageEntering) {
        // 클릭 승격은 사용자가 보고 있던(Quick-Look이면 확대된) rect에서 출발한다 — 1회용 출발
        // 채널이 비어 있으면(자동 승격 등) 비확대 캐시로 폴백한다.
        const from = takeTriageDeckDepartureRect(triageStageId) ?? getTriageDeckCardRect(triageStageId);
        if (from) {
          window.requestAnimationFrame(() => {
            const target = canvasRef.current?.querySelector<HTMLElement>(`.canvas-operation[data-operation-id="${escapeSelectorValue(triageStageId)}"]`) ?? null;
            if (target) flyPanelMotionGhost(from, target.getBoundingClientRect());
          });
        }
      }
    } else if (previousStageId && triageDeckOperations.length > 0 && !triageEntering) {
      const from = triageStageRectRef.current.get(previousStageId) ?? null;
      if (from) {
        window.requestAnimationFrame(() => {
          const to = getTriageDeckCardRect(previousStageId);
          if (to) flyPanelMotionGhost(from, to, () => flashTriageDeckCard(previousStageId));
        });
      }
    }
    previousTriageDeckStageRef.current = triageStageId;
    // 무대 체류 중 캔버스 리사이즈/컴패니언 개폐로 무대 rect가 변한다 — 최초 캡처본만 들고 있으면
    // 이후 복귀 flight가 옛 좌표에서 발사되므로, 체류 동안 관측해 캐시를 신선하게 유지한다.
    if (!triageStageId) return;
    const stageElement = canvasRef.current?.querySelector<HTMLElement>(`.canvas-operation[data-operation-id="${escapeSelectorValue(triageStageId)}"]`) ?? null;
    if (!stageElement) return;
    const refreshStageRect = () => {
      triageStageRectRef.current.set(triageStageId, stageElement.getBoundingClientRect());
    };
    const stageObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refreshStageRect);
    stageObserver?.observe(stageElement);
    window.addEventListener("resize", refreshStageRect);
    return () => {
      stageObserver?.disconnect();
      window.removeEventListener("resize", refreshStageRect);
    };
  }, [triageDeckOperations.length, triageActive, triageEntering, triageStageId]);
  useEffect(() => {
    if (state.activeOperationId
      && minimizedSet.has(state.activeOperationId)
      && (!triageActive || state.activeOperationId !== triageStageId)) {
      setActiveOperation(null);
    }
  }, [minimized, state.activeOperationId, triageActive, triageStageId]);
  useEffect(() => {
    if (!triageActive || !triageStageTheaterId || !triageStageId) {
      autoFocusedTriageStageRef.current = null;
      return;
    }
    // 무대 identity의 Theater는 활성 Theater가 아니라 무대 Operation의 소속이다 — 전 Theater
    // 마운트 모드에서 외부 소속 무대도 전환 없이 서기 때문이다.
    const nextStage = { theaterId: triageStageTheaterId, operationId: triageStageId };
    if (autoFocusedTriageStageRef.current?.theaterId === nextStage.theaterId
      && autoFocusedTriageStageRef.current.operationId === nextStage.operationId) return;
    autoFocusedTriageStageRef.current = nextStage;
    const frame = window.requestAnimationFrame(() => {
      if (document.querySelector(".feature-tour-layer") || hasVisibleModal(document)) return;
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement
        && activeElement.closest(".canvas-operation")
        && activeElement.matches("input, textarea, [contenteditable='true']")
        && !activeElement.closest(".xterm")) return;
      setActiveOperation(triageStageId, { acknowledged: false });
      requestOperationKeyboardFocus(triageStageId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [triageActive, triageStageId, triageStageTheaterId]);
  useLayoutEffect(() => {
    if (!triageActive || (!triageStageTheaterId && !state.activeTheaterId)) {
      companionTriageStageRef.current = clearInactiveTriageStageCompanion(companionTriageStageRef.current);
      return;
    }
    companionTriageStageRef.current = reconcileTriageStageCompanion(
      companionTriageStageRef.current,
      { theaterId: triageStageTheaterId ?? state.activeTheaterId!, operationId: triageStageId },
    );
    return () => {
      companionTriageStageRef.current = clearInactiveTriageStageCompanion(
        companionTriageStageRef.current,
      );
    };
  }, [state.activeTheaterId, triageActive, triageStageId, triageStageTheaterId]);
  useEffect(() => {
    if (!triageActive) {
      pendingTriageClearRef.current?.cancel();
      pendingTriageClearRef.current = null;
      previousTriageStageRef.current = null;
      triageStageActivityRef.current = null;
      return;
    }
    const pendingClear = pendingTriageClearRef.current;
    if (pendingClear) {
      const pendingOperation = state.operations.find((operation) => operation.id === pendingClear.operationId);
      const pickedId = getTriagePick();
      const replacedByPick = pickedId !== null && pickedId !== pendingClear.operationId;
      if (!pendingOperation
        || isTriageWaitingOperation(pendingOperation, state.operationRuntime)
        || replacedByPick) {
        pendingClear.cancel();
        pendingTriageClearRef.current = null;
        if (replacedByPick) {
          previousTriageStageRef.current = triageStageId;
          triageStageActivityRef.current = triageStage
            ? {
                operationId: triageStage.operation.id,
                activity: resolveOperationActivity(triageStage.operation, state.operationRuntime),
              }
            : null;
          return;
        }
      } else {
        previousTriageStageRef.current = pendingClear.operationId;
        return;
      }
    }
    const previousStage = triageStageActivityRef.current;
    if (previousStage) {
      const previousOperation = state.operations.find((operation) => operation.id === previousStage.operationId);
      if (previousOperation && !isTriageOperationDismissed(previousStage.operationId)) {
        const currentActivity = resolveOperationActivity(previousOperation, state.operationRuntime);
        if (isTriageClearedTransition(previousStage.activity, currentActivity)) {
          const operationId = previousStage.operationId;
          const cancel = scheduleTriageClear(
            operationId,
            () => {
              const runtime = triageRuntimeRef.current;
              const liveOperation = runtime.operations.find((operation) => operation.id === operationId);
              const pickedId = getTriagePick();
              return isTriageActive()
                && liveOperation !== undefined
                && !isTriageOperationDismissed(operationId)
                && !isTriageWaitingOperation(liveOperation, runtime.operationRuntime)
                && (pickedId === null || pickedId === operationId);
            },
            () => {
              pendingTriageClearRef.current = null;
              previousTriageStageRef.current = null;
              triageStageActivityRef.current = null;
            },
          );
          pendingTriageClearRef.current = { operationId, cancel };
          previousTriageStageRef.current = operationId;
          return;
        }
      }
    }
    previousTriageStageRef.current = triageStageId;
    triageStageActivityRef.current = triageStage
      ? {
          operationId: triageStage.operation.id,
          activity: resolveOperationActivity(triageStage.operation, state.operationRuntime),
        }
      : null;
  }, [state.operations, state.operationRuntime, triageActive, triageStage]);
  useEffect(() => () => {
    pendingTriageClearRef.current?.cancel();
    pendingTriageClearRef.current = null;
  }, []);
  const operationKindRegistry = registry.operationKinds;
  const maximizedOperationExists = maximizedOperationId !== null && theaterOperations.some((operation) => operation.id === maximizedOperationId && !minimizedSet.has(operation.id));
  const panelMaximized = maximizedOperationExists ? maximizedOperationId : null;
  // 선별 중 companion 대상은 외부 Theater 무대일 수 있다 — 전 Theater 목록에서 해석해야
  // 외부 무대의 companion layer가 열린다(비선별에는 활성 Theater로 한정해 기존 계약 유지).
  const currentCompanionOperation = companionOperationId === null ? undefined : (triageActive ? state.operations : theaterOperations).find((operation) => operation.id === companionOperationId && !minimizedSet.has(operation.id));
  const currentCompanionDescriptor = currentCompanionOperation ? operationKindRegistry.find((kind) => kind.pluginId === currentCompanionOperation.pluginId && kind.type === currentCompanionOperation.type) : undefined;
  const currentAvailableCompanionPanels = currentCompanionOperation
    ? availableCompanionPanels(currentCompanionDescriptor?.companions ?? [], currentCompanionOperation)
    : [];
  if (companionOperationId === null) lastValidCompanionRef.current = null;
  if (currentCompanionOperation && currentCompanionDescriptor && currentAvailableCompanionPanels.length > 0) {
    lastValidCompanionRef.current = { operation: currentCompanionOperation, descriptor: currentCompanionDescriptor };
  }
  const preservedCompanion = !currentCompanionOperation && lastValidCompanionRef.current?.operation.id === companionOperationId
    ? lastValidCompanionRef.current
    : null;
  const companionOperation = currentCompanionOperation ?? preservedCompanion?.operation;
  const companionDescriptor = currentCompanionDescriptor ?? preservedCompanion?.descriptor;
  const companionPanels = companionDescriptor?.companions ?? [];
  const availablePanels = companionOperation ? availableCompanionPanels(companionPanels, companionOperation) : [];
  const visibleCompanionPanels = availablePanels.filter((panel) => companionPanelVisibilityOverrides[panel.id] ?? !panel.defaultHidden);
  const hiddenCompanionPanelIds = companionPanels.filter((panel) => !visibleCompanionPanels.includes(panel)).map((panel) => panel.id);
  const panelCompanion = companionOperation && availablePanels.length > 0 ? companionOperation.id : null;
  const currentPanelCompanion = currentCompanionOperation && currentAvailableCompanionPanels.length > 0 ? currentCompanionOperation.id : null;
  // 전 Theater 마운트 모드의 무대는 활성 Theater 밖 Operation일 수 있다 — companion과 같은
  // 방식으로 프레임 목록에 합류시켜 Theater 전환 없이 무대를 세운다.
  const foreignStageOperation = triageStage && !theaterOperations.some((operation) => operation.id === triageStage.operation.id)
    ? triageStage.operation
    : null;
  const foreignCompanionOperation = companionOperation && !theaterOperations.some((operation) => operation.id === companionOperation.id)
    ? companionOperation
    : null;
  // 선별 중에는 덱이 전 Theater를 올리고, 그 칸마다 실제 패널이 선다 — 활성 Theater 것만
  // 프레임으로 만들면 다른 Theater의 칸은 영영 빈 자리로 남는다. 외부 무대·companion을 합류시키던
  // 기존 방식을 덱 전체로 넓힌다.
  const foreignDeckOperations = triageActive
    ? triageDeckOperations.filter((operation) => !theaterOperations.some((candidate) => candidate.id === operation.id))
    : [];
  const pluginOperations = foreignStageOperation || foreignCompanionOperation || foreignDeckOperations.length > 0
    ? [
        ...theaterOperations,
        ...foreignDeckOperations,
        ...(foreignCompanionOperation && !foreignDeckOperations.some((operation) => operation.id === foreignCompanionOperation.id)
          ? [foreignCompanionOperation]
          : []),
        ...(foreignStageOperation
          && foreignStageOperation.id !== foreignCompanionOperation?.id
          && !foreignDeckOperations.some((operation) => operation.id === foreignStageOperation.id)
          ? [foreignStageOperation]
          : []),
      ]
    : theaterOperations;
  const hasContent = triageActive ? triageStage !== null : hasVisibleCanvasContent(pluginOperations, minimizedSet);
  useEffect(() => {
    if (companionOperationId === null || currentPanelCompanion !== null) return;
    // ops 푸시 직후 대상 Operation이 목록에서 일시적으로 빠지는 레이스가 있어, 방금 연 분석
    // 레이아웃이 즉시 닫히지 않도록 부재가 지속될 때만 정리한다(복귀 시 cleanup으로 취소).
    const timer = setTimeout(() => {
      lastValidCompanionRef.current = null;
      forceDropCompanionOperationId();
    }, 1_500);
    return () => clearTimeout(timer);
  }, [companionOperationId, currentPanelCompanion]);
  // 캡션 그룹 라벨의 조회는 활성 Theater로 좁히지 않는다 — 선별 무대는 활성 Theater 밖 Operation도
  // 올린다. 소속 판정은 resolveOperationGroup이 Operation 자신의 Theater 기준으로 내린다.
  const groupById = new Map(state.groups.map((group) => [group.id, group]));
  const formationOperationIds = flattenGroupedOrder(
    theaterOperations,
    state.groups.filter((group) => group.theaterId === state.activeTheaterId),
    canvas.operationOrder,
    [],
  ).filter((operation) => !minimizedSet.has(operation.id)).map((operation) => operation.id);
  const formationCellCount = formationLayout === "grid"
    ? completeFormationGridCellCount(formationOperationIds.length)
    : formationOperationIds.length;
  const formationSlotArea = {
    x: 18,
    y: 18 + TITLEBAR_OUTSET_PX,
    width: Math.max(0, canvasSize.width - 36),
    height: Math.max(0, canvasSize.height - 36 - TITLEBAR_OUTSET_PX),
  };
  const allFormationSlots = formationView
    ? calculateGridSlots(
        { x: 0, y: TITLEBAR_OUTSET_PX, width: canvasSize.width, height: canvasSize.height - TITLEBAR_OUTSET_PX },
        formationCellCount,
        undefined,
        undefined,
        undefined,
        18,
        formationLayout,
      )
    : [];
  const formationSlots = allFormationSlots.slice(0, formationOperationIds.length);
  const formationGuideSlots = formationLayout === "grid"
    ? allFormationSlots.slice(formationOperationIds.length)
    : [];
  const formationSlotByOperationId = new Map(formationOperationIds.map((operationId, index) => [operationId, formationSlots[index]!]));
  const formationSlotIndexByOperationId = new Map(formationOperationIds.map((operationId, index) => [operationId, index + 1]));
  const focusCycleIds = focusCycleOperationIds(
    theaterOperations,
    state.groups.filter((group) => group.theaterId === state.activeTheaterId),
    canvas.operationOrder,
    canvas.collapsedGroups,
    canvas.minimized,
  );
  const focusCycleIndexByOperationId = new Map(focusCycleIds.map((operationId, index) => [operationId, index + 1]));
  // Formation 진입·레이아웃 전환 시 슬롯 순서 stagger — 윈도우 리사이즈 재배치에는 적용하지 않는다.
  useEffect(() => {
    if (!formationView || prefersReducedMotion()) return;
    const root = canvasRef.current;
    if (!root) return;
    const frames = formationOperationIds
      .map((operationId) => root.querySelector<HTMLElement>(`.canvas-operation[data-operation-id="${escapeSelectorValue(operationId)}"]`))
      .filter((element): element is HTMLElement => element !== null);
    // geometry 전용 CSS 변수 채널 — inline transition-delay는 존재 전환의 per-property 지연을 덮어쓴다.
    frames.forEach((element, index) => {
      element.style.setProperty("--panel-stagger-delay", `${index * 40}ms`);
      element.style.setProperty("--li", String(index));
    });
    const clear = () => {
      for (const element of frames) {
        element.style.removeProperty("--panel-stagger-delay");
        element.style.removeProperty("--li");
      }
    };
    // 진입 연출이 끝나는 1950ms까지 --li를 유지해야 마지막 타일의 착지 애니메이션이 잘리지 않는다.
    const timer = window.setTimeout(clear, 1_950);
    return () => {
      window.clearTimeout(timer);
      clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formationView, formationLayout]);
  // 최대화 시에는 net scale 1(기본 줌)로 렌더한다 — 현재 배율과 무관하게 터미널이 선명하게 그려진다.
  const effectiveZoom = panelMaximized || panelCompanion || formationView || triageActive ? 1 : canvas.viewport.zoom;
  const topPanelZIndex = maxOperationZIndex(canvas.operations) + 1;
  const companionSlotCount = visibleCompanionPanels.length + 1;

  return (
    <main
      className={`operations-canvas ${interaction.spaceActive ? "is-panning" : ""} ${interaction.shiftActive ? "is-creating" : ""} ${glanceVisible ? "is-glance" : ""} ${panelMaximized ? "is-panel-maximized" : ""} ${panelCompanion ? "is-companion-layout" : ""} ${formationView ? "is-formation-view" : ""} ${formationEntering ? "is-formation-entering" : ""} ${triageActive ? "is-triage" : ""} ${triageEntering ? "is-triage-entering" : ""}`}
      onPointerDown={(event) => {
        // 메뉴 내부 클릭(캔버스 소유 메뉴는 <main> 자손이라 버블로 도달한다)은 실행 항목의
        // click을 살리기 위해 닫기 신호를 본내지 않는다 — data-canvas-blocker는 전파를 멈추지 않는다.
        if (!(event.target instanceof Element && event.target.closest("[data-canvas-blocker], [data-canvas-operation]"))) {
          // 캔버스 제어 메뉴가 어느 소유자(사이드바 포털/이 컴포넌트)로부터 열었든 Map 클릭으로 닫는다 —
          // pan의 preventDefault+포인터 캡처가 mousedown 합성을 끊어 포털의 외부-클릭 닫기가 못 잡는다.
          window.dispatchEvent(new Event("canvas-context-menu-close"));
        }
        // War Room은 제스처 훅을 끄므로 Cruise onClick 해제가 닿지 않는다. 덱이 덮은 빈
        // 자리는 카드·점·패널이 아닌 곳에서 활성만 푼다 — 무대 지목은 그대로다.
        if (triageActive && event.button === 0 && isWarRoomEmptyReleaseTarget(event.target)) {
          clearActiveOperation();
        }
        interaction.onPointerDown(event as Parameters<typeof interaction.onPointerDown>[0]);
      }}
      onPointerMove={interaction.onPointerMove}
      onPointerUp={interaction.onPointerUp}
      onPointerCancel={interaction.onPointerCancel}
      onWheel={interaction.onWheel}
      onContextMenu={handleContextMenu}
      ref={canvasRef}
    >
      <CanvasGrid viewport={canvas.viewport} />
      <div
        style={{
          // 최대화 시 transform 제거(none)로 net scale 1. 일반 상태에서는 pan 좌표를 정수 픽셀로 스냅해
          // will-change 합성 레이어의 서브픽셀 오프셋 리샘플(글자 번짐)을 제거한다.
          transform: panelMaximized || panelCompanion || formationView || triageActive
            ? "none"
            : `translate(${Math.round(canvas.viewport.x)}px, ${Math.round(canvas.viewport.y)}px) scale(${canvas.viewport.zoom})`,
        }}
        className="operations-canvas-world"
      >
        {formationView ? formationGuideSlots.map((geometry, index) => {
          const frame = operationWindowFrameFor(geometry);
          return (
            <div
              key={`formation-guide-${formationOperationIds.length + index + 1}`}
              className="canvas-formation-guide"
              style={{
                left: Math.round(frame.x),
                top: Math.round(frame.y),
                width: Math.round(frame.width),
                height: Math.round(frame.height),
                "--gi": index,
              } as CSSProperties}
              aria-label={t("canvas.formation.slotAria", { index: formationOperationIds.length + index + 1 })}
            >
              <span className="canvas-formation-guide-index">
                {String(formationOperationIds.length + index + 1).padStart(2, "0")}
              </span>
            </div>
          );
        }) : null}
        {pluginOperations.map((operation) => {
          const baseGeometry = canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation);
          const operationMaximized = panelMaximized === operation.id;
          const operationCompanion = panelCompanion === operation.id;
          const operationTriageStage = triageStageId === operation.id;
          // 덱 칸이 잡혀 있으면 그 자리가 이 패널의 자리다 — 캔버스 좌표 대신 칸 안으로 들어가
          // 칸 크기를 그대로 입는다(PTY도 그 크기로 맞춰진다).
          // companion을 연 패널은 칸에 담기지 않는다 — 그 레이아웃은 캔버스를 나눠 쓰는 모드이고,
          // 렌더는 프레임과 companion 프레임을 한 벌로 내놓는다. 칸으로 들여보내면 캔버스 좌표를
          // 지닌 companion들이 타일 안으로 함께 딸려 들어간다. 덱 칸은 그때 이름만 남기고 비운다.
          const deckSlot = operationTriageStage || operationCompanion ? null : triageDeckSlots.get(operation.id) ?? null;
          const operationGroup = resolveOperationGroup(operation, groupById);
          // 색을 못 푸는 그룹은 라벨 자체를 내지 않는다 — 도트 없는 이름만 남으면 그것이 그룹이라는
          // 사실을 캡션에서 읽을 수 없다.
          const operationGroupColor = operationGroup ? resolveAccentColor(operationGroup.color) : null;
          // focus layer는 peer를 실제 최소화하지 않고, mount를 보존한 채 렌더만 감춘다.
          // 선별 중 무대 밖 패널은 감추는 대상이 아니다 — 덱 칸에 자기 자리를 갖고 거기 서 있다.
          const focusLayerHidden = triageActive
            ? !operationTriageStage && !deckSlot
            : (panelMaximized !== null || panelCompanion !== null) && !operationMaximized && !operationCompanion;
          const formationSlot = formationSlotByOperationId.get(operation.id);
          const glanceHud = resolveGlanceHudModel(triageActive
            ? {
                mode: "triage",
                index: Math.max(1, triageDisplayQueue.findIndex((entry) => entry.operation.id === operation.id) + 1),
                total: triageDisplayQueue.length,
                companionOpen: panelCompanion !== null,
                setAsideArmed: operationTriageStage && setAsideArmedId === operation.id,
              }
            : formationView
              ? {
                  mode: "formation",
                  index: formationSlotIndexByOperationId.get(operation.id) ?? 1,
                  maximized: operationMaximized,
                  companionOpen: panelCompanion !== null,
                }
              : {
                  mode: "map",
                  index: focusCycleIndexByOperationId.get(operation.id) ?? 1,
                  maximized: operationMaximized,
                  companionOpen: panelCompanion !== null,
                });
          const frameGeometry = operationTriageStage
            ? triageStageGeometryFor(canvasSize, topPanelZIndex, 0, triageActive && operationCompanion ? companionSlotCount : 1)
            : operationMaximized
            ? maximizedGeometryFor(canvasSize, topPanelZIndex)
            : operationCompanion
            ? formationView
              ? modeSlotGeometryFor(formationSlotArea, 0, companionSlotCount, 8, topPanelZIndex)
              : companionGeometryFor(canvasSize, 0, companionSlotCount, topPanelZIndex)
            : formationSlot ? { ...baseGeometry, ...formationSlot } : baseGeometry;
          // 보더 위 캡션(top: -32px)이 캔버스 상단 클립에 잘리는 뷰포트-상대 위치.
          // Tactical/War Room/최대화는 슬롯을 32px 내려 캡션을 밖에 둔다. 본문·PTY geometry는 그대로다.
          const topEdge = !operationTriageStage && !operationMaximized && !operationCompanion && !formationSlot && !deckSlot
            && canvas.viewport.y + frameGeometry.y * effectiveZoom < TITLEBAR_OUTSET_PX * effectiveZoom;
          return renderPluginOperation(operation, {
            active: activePluginOperationId === operation.id,
            unseen: idleArrivalIds.has(operation.id),
            keyboardFocusRequestId: state.keyboardFocusRequest?.operationId === operation.id
              ? state.keyboardFocusRequest.requestId
              : 0,
            geometry: frameGeometry,
            topEdge,
            operationKindRegistry,
            // 캡션 비콘은 사이드바 칩과 같은 원천을 읽어야 한다 — 런타임 맵을 날로 조회하면 아직
            // 런타임 축을 심지 않은 복원 Operation이 doctrine상 dormant인데도 캡션에서만 idle로 서서,
            // 같은 순간 사이드바는 휴면, 패널은 초록이라고 말한다.
            status: resolveOperationActivity(operation, state.operationRuntime),
            runtimeState: pluginRuntimeState(state.operationRuntime, state.operationRuntimeHydration, operation.id),
            theme: state.activeTheme,
            language,
            viewportZoom: effectiveZoom,
            // 선별 중 무대 밖 패널은 덱 칸으로 간다 — 자리가 있으면 그 자리에 실물로 서므로
            // 숨기지 않고, 자리가 아직 없을 때만(입장 연출·지도 전환 직전) 접어 둔다.
            minimized: triageActive ? !operationTriageStage && !deckSlot : minimizedSet.has(operation.id),
            maximized: operationMaximized,
            triageStage: operationTriageStage,
            triagePicked: operationTriageStage && triageStage?.picked === true,
            glanceHud,
            companion: operationCompanion,
            companions: operationCompanion ? visibleCompanionPanels : [],
            companionGeometries: operationCompanion
              ? visibleCompanionPanels.map((_, index) => triageActive
                  ? triageStageGeometryFor(canvasSize, topPanelZIndex, index + 1, companionSlotCount)
                  : formationView
                    ? modeSlotGeometryFor(formationSlotArea, index + 1, companionSlotCount, 8, topPanelZIndex)
                    : companionGeometryFor(canvasSize, index + 1, companionSlotCount, topPanelZIndex))
              : [],
            hiddenCompanionPanelIds: operationCompanion ? hiddenCompanionPanelIds : [],
            formation: formationView || triageActive,
            focusLayerHidden,
            operationBodyPoolAvailable,
            deckSlot,
            onRenderHiddenFocus: () => {
              // 숨은 peer의 포커스는 전면 프레임만 받는다. Map <main>은 키보드 정거장이 아니라서
              // 폴백으로 가져가면 채팅 본문 클릭·Enter가 바다에 :focus-visible brass 링을 남긴다.
              canvasRef.current?.querySelector<HTMLElement>("[data-focus-layer-target='true']")?.focus();
            },
            accentKey: canvas.operationAccent[operation.id] ?? operationAccentFromNode(operation),
            groupName: operationGroup?.name ?? null,
            groupColor: operationGroupColor,
            theaterLabel: operation.type === "shell"
              ? state.theaters.find((theater) => theater.id === operation.theaterId)?.label || null
              : null,
            onActivate: () => {
              setActiveOperation(operation.id);
              // 선별 중에는 기록하지 않는다 — 무대는 슬롯 geometry이고, 외부 Theater 무대의 기록은
              // 활성 Theater 캔버스 store를 오염시킨다.
              if (!operationMaximized && !operationCompanion && !formationView && !triageActive) setOperationGeometry(operation.id, canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation));
            },
            onClose: () => {
              if (triageActive) dismissTriageOperation(operation.id);
              if (state.activeOperationId === operation.id) setActiveOperation(null);
              if (panelMaximized === operation.id) clearMaximizedOperationId();
              if (panelCompanion === operation.id) forceDropCompanionOperationId();
              onClose(operation.id);
            },
            onMinimize: () => {
              if (state.activeOperationId === operation.id) setActiveOperation(null);
              clearIdleArrival(operation.id);
              if (triageActive) {
                // War Room의 최소화는 deck에서 내리는 동작이다. 무대에 서 있던 패널이면 지목까지
                // 거둬 무대를 함께 비운다 — 지목이 남으면 큐가 비어도 그 패널이 무대에 붙어 있다.
                forgetTriageOperation(operation.id);
                setTheaterOperationMinimized(operation.theaterId, operation.id, true);
                return;
              }
              playMinimizeFlight(operation.id);
              minimizeOperation(operation.id);
            },
            onMaximize: () => {
              if (operationMaximized) {
                clearMaximizedOperationId();
              } else {
                setActiveOperation(operation.id);
                setMaximizedOperationId(operation.id);
              }
            },
            onRename: (title) => {
              onRename(operation.id, title);
            },
            onOpenMenu: (anchor, returnFocus) => {
              onOpenOperationMenu?.(operation.id, anchor, returnFocus);
            },
            onRenderHiddenDismissMenu: () => {
              onDismissOperationMenu?.(operation.id);
            },
            onGeometryChange: (geometry) => {
              if (!operationMaximized && !operationCompanion && !formationView && !triageActive) setOperationGeometry(operation.id, geometry);
            },
            onGeometryCommit: (geometry) => {
              if (operationMaximized || operationCompanion || formationView) return;
              // Station Keeping: 해제 시점에 만진 패널만 정착시킨 뒤, 정착된 스냅샷을 durable로 보낸다.
              if (!triageActive) settleOperationGeometry(operation.id);
              void updatePluginOperationGeometry(operation.id, getCanvasSnapshot().operations[operation.id] ?? geometry);
            },
          });
        })}
      </div>
      {formationView ? (
        <>
          <div className="canvas-mode-frame" aria-hidden="true">
            <span className="canvas-mode-bracket canvas-mode-bracket--nw" />
            <span className="canvas-mode-bracket canvas-mode-bracket--ne" />
            <span className="canvas-mode-bracket canvas-mode-bracket--sw" />
            <span className="canvas-mode-bracket canvas-mode-bracket--se" />
          </div>
          {formationEntering ? (
            <div className="canvas-mode-curtain canvas-formation-curtain" aria-hidden="true">
              <span className="canvas-mode-curtain-kicker">{t("canvas.formation.curtainKicker")}</span>
              <span className="canvas-mode-curtain-ruler" />
              <strong>{t("canvas.formation.curtainTitle")}</strong>
              <span>{t("canvas.formation.curtainBody", { count: formationOperationIds.length })}</span>
            </div>
          ) : null}
        </>
      ) : null}
      {triageActive ? (
        <>
          <div className="canvas-mode-frame" aria-hidden="true">
            <span className="canvas-mode-bracket canvas-mode-bracket--nw" />
            <span className="canvas-mode-bracket canvas-mode-bracket--ne" />
            <span className="canvas-mode-bracket canvas-mode-bracket--sw" />
            <span className="canvas-mode-bracket canvas-mode-bracket--se" />
          </div>
          {/* 하단 대기 레일은 제거됐다 — 사이드바 '대기'가 이미 같은 순서를 쥐고 있어, 두 곳이
              동시에 "처리할 것이 있다"고 말하면 시선만 화면 아래위로 갈라진다(제품 결정). */}
          {triageEntering ? <div className="canvas-triage-sweep" aria-hidden="true" /> : null}
          {triageEntering ? (
            <div className="canvas-mode-curtain canvas-triage-curtain" aria-hidden="true">
              <span className="canvas-mode-curtain-kicker">{t("canvas.triage.curtainKicker")}</span>
              <span className="canvas-mode-curtain-ruler" />
              <strong>{t("canvas.triage.curtainTitle")}</strong>
              <span>{triageQueue.length > 0
                ? t("canvas.triage.curtainBody", { waiting: triageQueue.length, stowed: Math.max(0, triageDeckOperations.length - 1) })
                : t("canvas.triage.curtainBodyEmpty", { stowed: triageDeckOperations.length })}</span>
            </div>
          ) : null}
        </>
      ) : null}
      <TriageWatchDeck
        active={triageActive}
        entering={triageEntering}
        theaters={state.theaters}
        operations={triageDeckOperations}
        operationRuntime={state.operationRuntime}
        operationAccent={canvas.operationAccent}
        arrivingOperationId={triageDeckArrivingOperationId}
        stagedOperationId={triageStageId}
        onBeforePick={triageDeckZoom.control.snapZoomTween}
        mapGeometryFor={(operation) => operation.theaterId === state.activeTheaterId
          ? canvas.operations[operation.id] ?? operation.geometry ?? null
          : getTheaterCanvasSnapshot(operation.theaterId).operations[operation.id] ?? operation.geometry ?? null}
        onPanelSlotRef={registerTriageDeckSlot}
        freshOperationIds={freshDeckOperationIds}
        onMapMarkerMove={(operationId, theaterId, geometry) => {
          // 지도에서 옮긴 자리는 캔버스의 자리다 — 라이브 좌표를 먼저 세우고 durable에도 남긴다.
          setTheaterOperationGeometry(theaterId, operationId, geometry);
          void updatePluginOperationGeometry(operationId, geometry);
        }}
        onOperationContextMenu={onOpenOperationMenu}
        onTheaterContextMenu={openTriageTheaterLaunchMenu}
      />
      {cruiseEntering ? (
        <div className="canvas-mode-curtain canvas-cruise-curtain" aria-hidden="true">
          <span className="canvas-mode-curtain-kicker">{t("canvas.cruise.curtainKicker")}</span>
          <span className="canvas-mode-curtain-ruler" />
          <strong>{t("canvas.cruise.curtainTitle")}</strong>
          <span>{formationOperationIds.length > 0
            ? t("canvas.cruise.curtainBody", { count: formationOperationIds.length })
            : t("canvas.cruise.curtainBodyEmpty")}</span>
        </div>
      ) : null}
      <TriageClearPlate active={triageActive && triageDeckOperations.length === 0} entering={triageEntering} hasContent={hasContent} idleCount={triageIdleCount} />
      {!triageActive && !hasContent && !formationEntering && !cruiseEntering ? (
        <OperationsCanvasEmptyState
          activeTheaterId={state.activeTheaterId}
          theaterLabel={state.theaters.find((theater) => theater.id === state.activeTheaterId)?.label ?? state.activeTheaterId ?? ""}
          operations={theaterOperations}
          canLaunch={canLaunch}
          onOpenOperation={onFocus}
          onOpenAll={onOpenAll}
          onNewOperation={requestOperationLaunchMenu}
        />
      ) : null}
      {interaction.rubberBand ? <RubberBand rect={interaction.rubberBand} viewport={canvas.viewport} /> : null}
      {contextMenu ? (
        <CanvasContextMenu
          key={`${contextMenu.anchor.x}:${contextMenu.anchor.y}`}
          anchor={contextMenu.anchor}
          viewportBounds={viewportBoundsFor(canvasRef.current)}
          placement="cursor"
          catalog={catalog}
          // 실행 가부는 모드가 아니라 Theater가 정한다 — 사이드바와 좌하단 런처는 어느 모드에서도
          // 같은 catalog를 그대로 실행하므로, 여기만 Formation을 이유로 막으면 같은 메뉴가
          // 진입 경로에 따라 죽는다. Formation이 막는 것은 캔버스 제스처(팬·줌·드래그 생성)뿐이다.
          canLaunch={canLaunch}
          renderKindIcon={renderKindIcon}
          onLaunchKind={handleContextMenuLaunchKind}
          onClose={() => setContextMenu(null)}
          fixed={triageActive}
        />
      ) : null}
      <CanvasMinimap
        operations={visibleOperations}
        pluginOperations={Object.fromEntries(theaterOperations.filter((operation) => !minimizedSet.has(operation.id)).map((operation) => [operation.id, {
          theaterId: operation.theaterId,
          geometry: canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation),
        }]))}
        accents={Object.fromEntries(theaterOperations.flatMap((operation) => {
          const accentKey = canvas.operationAccent[operation.id] ?? operationAccentFromNode(operation);
          const color = accentKey ? resolveAccentColor(accentKey) : null;
          return color ? [[operation.id, color] as const] : [];
        }))}
        viewport={canvas.viewport}
        canvasSize={canvasSize}
        onJump={(center) => setViewport({
          x: canvasSize.width / 2 - center.x * canvas.viewport.zoom,
          y: canvasSize.height / 2 - center.y * canvas.viewport.zoom,
          zoom: canvas.viewport.zoom,
        })}
      />
    </main>
  );
}

function viewportBoundsFor(element: HTMLElement | null): { readonly width: number; readonly height: number } | undefined {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function rectToGeometry(rect: CanvasRect): OperationGeometry {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, zIndex: 0 };
}

function ensurePluginGeometry(operation: OperationNode): OperationGeometry {
  return operation.geometry ?? { x: 0, y: 0, width: DEFAULT_SHELL_WIDTH, height: DEFAULT_SHELL_HEIGHT, zIndex: 0 };
}

// 최대화 패널은 world transform이 none인 상태에서 렌더되므로 화면 좌표(0,0) 기준 캔버스 풀사이즈로 배치한다.
// viewport에 의존하지 않아 현재 줌/팬과 무관하게 항상 net scale 1로 최대화된다.
function maximizedGeometryFor(canvasSize: { readonly width: number; readonly height: number }, zIndex: number): OperationGeometry {
  return {
    x: 0,
    y: TITLEBAR_OUTSET_PX,
    width: Math.max(320, canvasSize.width),
    height: Math.max(240, canvasSize.height - TITLEBAR_OUTSET_PX),
    zIndex,
  };
}

// Companion layout은 world transform이 none인 전용 화면 레이아웃이다. Operation과 companion panel이
// 동일한 슬롯 폭을 사용하므로 Map의 geometry/viewport를 변경하지 않고 EXIT 시 원상 복원된다.
function companionGeometryFor(canvasSize: { readonly width: number; readonly height: number }, slotIndex: number, slotCount: number, zIndex: number): OperationGeometry {
  const count = Math.max(1, slotCount);
  const gap = 8;
  const width = Math.max(0, (canvasSize.width - gap * (count - 1)) / count);
  return {
    x: slotIndex * (width + gap),
    y: TITLEBAR_OUTSET_PX,
    width,
    height: Math.max(0, canvasSize.height - TITLEBAR_OUTSET_PX),
    zIndex,
  };
}

function maxOperationZIndex(operations: Record<string, OperationGeometry>): number {
  return Object.values(operations).reduce((max, geometry) => Math.max(max, geometry.zIndex), 0);
}

export function useGlanceHold(): boolean {
  const [glanceVisible, setGlanceVisible] = useState(false);
  const heldAltCodesRef = useRef(new Set<string>());

  useEffect(() => {
    const clearGlance = () => {
      heldAltCodesRef.current.clear();
      setGlanceVisible(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      // 콘솔 전역 단축키 관례(global-shortcuts)와 동일하게, 블로킹 다이얼로그 위에는 HUD를 띄우지 않는다.
      if (!isGlanceAltKey(event) || event.repeat || event.ctrlKey || event.metaKey || isBlockingDialogOpen()) return;
      heldAltCodesRef.current.add(event.code);
      setGlanceVisible(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!isGlanceAltKey(event)) return;
      heldAltCodesRef.current.delete(event.code);
      setGlanceVisible(heldAltCodesRef.current.size > 0);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") clearGlance();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearGlance);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearGlance);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return glanceVisible;
}

export function clearInactiveTriageStageCompanion(
  previous: TriageStageIdentity | null,
): null {
  if (previous) disarmTriageSetAside();
  return null;
}

function isGlanceAltKey(event: KeyboardEvent): boolean {
  return event.code === "AltLeft" || event.code === "AltRight";
}

function resolveDefaultLaunchTarget(catalog: readonly OperationCatalogPlugin[]): { readonly pluginId: string; readonly kind: OperationLaunchKind } | null {
  const availableKinds = catalog.flatMap((plugin) =>
    plugin.kinds.filter((kind) => kind.disabled !== true).map((kind) => ({ pluginId: plugin.id, kind })),
  );
  return availableKinds.find(({ kind }) => kind.type === "shell") ?? availableKinds[0] ?? null;
}

// 패널 헤더 이름 변경은 캔버스 내부에서 즉시 처리한다.
function operationAccentFromNode(operation: OperationNode): string | null {
  return typeof operation.accent === "string" ? operation.accent : null;
}

function renderPluginOperation(operation: OperationNode, options: {
  readonly active: boolean;
  readonly unseen: boolean;
  readonly keyboardFocusRequestId: number;
  readonly geometry: OperationGeometry;
  readonly operationKindRegistry: readonly OperationKindDescriptor[];
  readonly status?: OperationActivityVisual;
  readonly runtimeState: OperationRuntimeState | null;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly viewportZoom: number;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly triageStage: boolean;
  readonly triagePicked: boolean;
  readonly glanceHud: GlanceHudModel;
  readonly companion: boolean;
  readonly companions: readonly CompanionPanelDescriptor[];
  readonly companionGeometries: readonly OperationGeometry[];
  readonly hiddenCompanionPanelIds: readonly string[];
  readonly formation: boolean;
  readonly focusLayerHidden: boolean;
  readonly operationBodyPoolAvailable: boolean;
  /** War Room 덱이 이 Operation에게 내준 자리 — 있으면 프레임이 캔버스가 아니라 그 칸 안에 선다. */
  readonly deckSlot: HTMLElement | null;
  readonly onRenderHiddenFocus: () => void;
  readonly topEdge: boolean;
  readonly accentKey: string | null;
  readonly groupName: string | null;
  readonly groupColor: string | null;
  readonly theaterLabel: string | null;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onMinimize: () => void;
  readonly onMaximize: () => void;
  readonly onRename: (title: string) => void;
  readonly onOpenMenu?: (anchor: DOMRect, returnFocus: HTMLElement | null) => void;
  readonly onRenderHiddenDismissMenu?: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  readonly onGeometryCommit: (geometry: OperationGeometry) => void;
}) {
  const descriptor = options.operationKindRegistry.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);
  const geometry = options.geometry;
  if (!descriptor?.render) return null;
  const capabilities = createHostCapabilities(() => {
    void fetchOperations(null).then(hydrateOperations).catch(() => {});
  });
  const onRequestCompanions = (open: boolean) => {
    if (open) {
      setActiveOperation(operation.id);
      setCompanionOperationId(operation.id);
    } else clearCompanionOperationId();
  };
  const onSetCompanionPanelVisible = (companionPanelId: string, visible: boolean) => {
    setCompanionPanelVisible(operation.id, companionPanelId, visible);
  };
  const frame = (
    <Fragment key={operation.id}>
      <OperationFrame
        operation={operation}
        active={options.active}
        unseen={options.unseen}
        geometry={geometry}
        zoom={options.viewportZoom}
        status={options.status}
        minimized={options.minimized}
        maximized={options.maximized}
        triageStage={options.triageStage}
        triagePicked={options.triagePicked}
        deckTile={options.deckSlot !== null}
        glanceHud={options.glanceHud}
        topEdge={options.topEdge}
        renderHidden={options.focusLayerHidden}
        focusLayerTarget={options.maximized || options.companion}
        interactionDisabled={options.formation || options.companion || options.focusLayerHidden || options.triageStage || options.deckSlot !== null}
        accentKey={options.accentKey}
        groupName={options.groupName}
        groupColor={options.groupColor}
        theaterLabel={options.theaterLabel}
        onActivate={options.onActivate}
        onClose={options.onClose}
        onMinimize={options.onMinimize}
        onMaximize={options.onMaximize}
        onRename={options.onRename}
        onOpenMenu={options.onOpenMenu}
        onRenderHiddenDismissMenu={options.onRenderHiddenDismissMenu}
        onGeometryChange={options.onGeometryChange}
        onGeometryCommit={options.onGeometryCommit}
        onRenderHiddenFocus={options.onRenderHiddenFocus}
        captionActions={descriptor.captionActions === undefined || options.deckSlot !== null ? null : (
          // 본문과 같은 context로 그린다 — 캡션이 본문과 다른 사실을 말하는 프레임이 나오지 않게.
          // 실패해도 32px 밴드에 오류 상자를 세울 자리는 없으므로, 선반만 조용히 비운다.
          // (fallback을 생략하거나 null로 두면 `??`가 기본 오류 상자를 되살린다 — 빈 조각이라야 빈다.)
          <PluginErrorBoundary fallback={<></>}>
            <PluginOperationRenderer
              active={options.active}
              capabilities={capabilities}
              geometry={geometry}
              operation={operation}
              theme={options.theme}
              language={options.language}
              viewportZoom={options.viewportZoom}
              runtimeState={options.runtimeState}
              onActivate={options.onActivate}
              onClose={options.onClose}
              onGeometryChange={options.onGeometryChange}
              onRequestCompanions={onRequestCompanions}
              companionsOpen={options.companion}
              hiddenCompanionPanelIds={options.hiddenCompanionPanelIds}
              onSetCompanionPanelVisible={onSetCompanionPanelVisible}
              bodyLive={!options.minimized && !options.focusLayerHidden}
              render={descriptor.captionActions}
            />
          </PluginErrorBoundary>
        )}
      >
        {options.operationBodyPoolAvailable ? (
          <OperationBodySlot
            operationId={operation.id}
            className="canvas-operation-body-slot"
            config={{
              active: options.active,
              keyboardFocusRequestId: options.keyboardFocusRequestId,
              geometry,
              operation,
              runtimeState: options.runtimeState,
              bodyLive: !options.minimized && !options.focusLayerHidden,
              theme: options.theme,
              language: options.language,
              zoom: options.viewportZoom,
              onActivate: options.onActivate,
              onClose: options.onClose,
              onGeometryChange: options.onGeometryChange,
              onRequestCompanions,
              companionsOpen: options.companion,
              hiddenCompanionPanelIds: options.hiddenCompanionPanelIds,
              onSetCompanionPanelVisible,
            } satisfies OperationBodyConfig}
          />
        ) : (
          <PluginErrorBoundary fallback={<PluginRenderError messageKey="canvas.plugin.operationFailed" />}>
            <PluginOperationRenderer
              active={options.active}
              keyboardFocusRequestId={options.keyboardFocusRequestId}
              capabilities={capabilities}
              geometry={geometry}
              operation={operation}
              theme={options.theme}
              language={options.language}
              viewportZoom={options.viewportZoom}
              runtimeState={options.runtimeState}
              onActivate={options.onActivate}
              onClose={options.onClose}
              onGeometryChange={options.onGeometryChange}
              onRequestCompanions={onRequestCompanions}
              companionsOpen={options.companion}
              hiddenCompanionPanelIds={options.hiddenCompanionPanelIds}
              onSetCompanionPanelVisible={onSetCompanionPanelVisible}
              bodyLive={!options.minimized && !options.focusLayerHidden}
              render={descriptor.render}
            />
          </PluginErrorBoundary>
        )}
      </OperationFrame>
      {options.companions.map((companion, index) => (
        <CompanionFrame
          key={companion.id}
          descriptor={companion}
          geometry={options.companionGeometries[index]!}
          language={options.language}
          caption={companion.caption === undefined ? null : (
            // 캡션 내용도 본문과 같은 context로 그린다 — 두 슬롯이 서로 다른 컨텍스트를 받으면
            // 정체·상태가 본문과 어긋난 프레임이 나온다.
            <PluginErrorBoundary fallback={<PluginRenderError messageKey="canvas.plugin.companionFailed" />}>
              <PluginOperationRenderer
                active={options.active}
                capabilities={capabilities}
                geometry={geometry}
                operation={operation}
                theme={options.theme}
                language={options.language}
                viewportZoom={options.viewportZoom}
                runtimeState={options.runtimeState}
                onActivate={options.onActivate}
                onClose={options.onClose}
                onGeometryChange={options.onGeometryChange}
                onRequestCompanions={onRequestCompanions}
                companionsOpen={options.companion}
                hiddenCompanionPanelIds={options.hiddenCompanionPanelIds}
                onSetCompanionPanelVisible={onSetCompanionPanelVisible}
                render={companion.caption}
              />
            </PluginErrorBoundary>
          )}
        >
          <PluginErrorBoundary fallback={<PluginRenderError messageKey="canvas.plugin.companionFailed" />}>
            <PluginOperationRenderer
              active={options.active}
              capabilities={capabilities}
              geometry={geometry}
              operation={operation}
              theme={options.theme}
              language={options.language}
              viewportZoom={options.viewportZoom}
              runtimeState={options.runtimeState}
              onActivate={options.onActivate}
              onClose={options.onClose}
              onGeometryChange={options.onGeometryChange}
              onRequestCompanions={onRequestCompanions}
              companionsOpen={options.companion}
              hiddenCompanionPanelIds={options.hiddenCompanionPanelIds}
              onSetCompanionPanelVisible={onSetCompanionPanelVisible}
              render={companion.render}
            />
          </PluginErrorBoundary>
        </CompanionFrame>
      ))}
    </Fragment>
  );
  // 덱 칸이 있으면 그 자리로 들여보낸다 — React 트리는 그대로라 상태·이벤트·pool 배선이 모두
  // 유지되고, 바뀌는 것은 DOM 상의 부모뿐이다. 자리가 사라지면 프레임은 캔버스로 되돌아온다.
  return options.deckSlot ? createPortal(frame, options.deckSlot, operation.id) : frame;
}

function PluginOperationRenderer({
  active,
  keyboardFocusRequestId,
  capabilities,
  geometry,
  operation,
  theme,
  language,
  viewportZoom,
  runtimeState,
  onActivate,
  onClose,
  onGeometryChange,
  onRequestCompanions,
  companionsOpen,
  hiddenCompanionPanelIds,
  onSetCompanionPanelVisible,
  bodyLive,
  render,
}: PluginOperationRendererProps) {
  return render({
    operationId: operation.id,
    theaterId: operation.theaterId,
    pluginId: operation.pluginId,
    type: operation.type,
    operation,
    geometry,
    active,
    ...(keyboardFocusRequestId === undefined ? {} : { keyboardFocusRequestId }),
    zoom: viewportZoom,
    theme,
    language,
    api: capabilities.api,
    lifecycle: capabilities.lifecycle,
    terminal: capabilities.terminal,
    notifications: capabilities.notifications,
    operations: capabilities.operations,
    preferences: capabilities.preferences,
    settings: capabilities.settings,
    runtime: capabilities.runtime,
    runtimeState,
    ...(bodyLive === undefined ? {} : { bodyLive }),
    statusDetail: capabilities.statusDetail,
    composer: capabilities.composer,
    onActivate,
    onClose,
    onGeometryChange,
    onRequestCompanions,
    companionsOpen,
    hiddenCompanionPanelIds,
    onSetCompanionPanelVisible,
  }) as ReactNode;
}

function PluginRenderError({ messageKey }: { readonly messageKey: "canvas.plugin.operationFailed" | "canvas.plugin.companionFailed" }) {
  const t = useT();
  return <div className="fc-plugin-error">{t(messageKey)}</div>;
}

function CompanionFrame({ descriptor, geometry, language, caption, children }: {
  readonly descriptor: CompanionPanelDescriptor;
  readonly geometry: OperationGeometry;
  readonly language: ConsoleLocale;
  readonly caption: ReactNode;
  readonly children: ReactNode;
}) {
  const t = useT();
  const title = resolveLocalizedText(descriptor.title, language);
  const frameStyle = {
    left: Math.round(geometry.x),
    top: Math.round(geometry.y),
    width: Math.round(geometry.width),
    height: Math.round(geometry.height),
    zIndex: geometry.zIndex,
  } satisfies CSSProperties;
  return (
    <article className="canvas-operation canvas-companion-frame" style={frameStyle} data-canvas-operation aria-label={t("canvas.companion.aria", { title })}>
      {descriptor.hideCaption ? null : (
        <header className="canvas-companion-caption" data-canvas-blocker>
          {caption ?? (
            <>
              <span className="canvas-companion-caption-dot" aria-hidden="true" />
              <span className="canvas-companion-caption-title">{title}</span>
            </>
          )}
        </header>
      )}
      <div className="canvas-operation-terminal canvas-companion-body" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} data-canvas-blocker>
        {children}
      </div>
    </article>
  );
}

async function updatePluginOperationGeometry(operationId: string, geometry: OperationGeometry): Promise<void> {
  await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geometry }),
  });
}

function hasVisibleModal(root: ParentNode): boolean {
  return [...root.querySelectorAll<HTMLElement>('[aria-modal="true"]')].some((element) => {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function completeFormationGridCellCount(count: number): number {
  if (count <= 0) return 0;
  const columns = Math.ceil(Math.sqrt(count));
  return columns * Math.ceil(count / columns);
}
