import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { CompanionPanelDescriptor, ConsoleTheme, FleetClientPlugin, OperationActivity, OperationKindDescriptor, OperationRenderContext } from "@fleet-console/sdk/plugin";

import { fetchOperations } from "../api.js";
import { availableCompanionPanels } from "../companion-shortcut.js";
import { isBlockingDialogOpen } from "../focus-guards.js";
import { flattenGroupedOrder, focusCycleOperationIds, hydrateOperations, requestOperationKeyboardFocus, requestOperationLaunchMenu, setActiveOperation } from "../store.js";
import { createHostCapabilities } from "../plugin-capabilities.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { useGlobalSettingsStore } from "../global-settings-store.js";
import { useT } from "../i18n/index.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../operation-idle-arrival.js";
import { resolveOperationActivity } from "../operation-activity.js";
import type { ConsoleState, OperationNode } from "../types.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";
import { OperationBodySlot, useOperationBodyPoolAvailable, type OperationBodyConfig } from "../mobile/operation-body-pool.js";
import { calculateGridSlots, animateViewportTo, claimTopZIndex, clearCompanionOperationId, clearMaximizedOperationId, consumePendingFitAllOperations, focusOperation, forceDropCompanionOperationId, getSnapshot as getCanvasSnapshot, getTheaterCanvasSnapshot, minimizeOperation, panelMotionSuppressed, resetCanvasViewportSize, restoreOperation, setCanvasViewportSize, setCompanionOperationId, setCompanionPanelVisible, setMaximizedOperationId, setOperationGeometry, setViewport, useCanvasState, useCompanionOperationId, useCompanionPanelVisibilityOverrides, useFormationLayout, useFormationView, useMaximizedOperationId, useMinimized, type OperationGeometry } from "./canvas-store.js";
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
import { modeSlotGeometryFor, screenToCanvas, triageStageGeometryFor, type CanvasPoint, type CanvasRect } from "./coordinates.js";
import { disarmTriageSetAside, dismissTriageOperation, getTriageCleared, getTriageEnteredAt, getTriagePick, getTriageSetAsideArmedId, getTriageSnapshot, isTriageActive, isTriageClearedTransition, isTriageOperationDeferred, isTriageOperationDismissed, isTriageWaitingOperation, pickTriageOperation, reconcileTriageStageCompanion, recordTriageStageTheater, resolveTriageQueue, scheduleTriageClear, subscribeTriage, useTriageActive, useTriageSpotlightEnabled, type TriageQueueEntry, type TriageStageIdentity } from "./triage-store.js";

interface OperationsCanvasProps {
  readonly state: ConsoleState;
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly canLaunch: boolean;
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind, canvasPoint: CanvasPoint) => void;
  readonly onLaunchAtGeometry: (pluginId: string, kind: OperationLaunchKind, geometry: OperationGeometry) => void;
  readonly onClose: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onRename: (operationId: string, title: string) => void;
  readonly onSetAccent: (operationId: string, accentKey: string | null) => void;
}

interface ContextMenuRequest {
  readonly anchor: CanvasPoint;
  readonly canvasPoint: CanvasPoint;
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
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  readonly onRequestCompanions: (open: boolean) => void;
  readonly companionsOpen: boolean;
  readonly hiddenCompanionPanelIds: readonly string[];
  readonly onSetCompanionPanelVisible: (companionPanelId: string, visible: boolean) => void;
  readonly render: (context: OperationRenderContext) => unknown;
}

const DEFAULT_SHELL_WIDTH = 560;
const DEFAULT_SHELL_HEIGHT = 360;
/* components.css의 .canvas-operation-titlebar top(-1 * --space-3)과 짝을 이루는 상수. */
const TITLEBAR_OUTSET_PX = 12;
// 프리뷰 config는 identity 비교로 재발행이 억제되므로 공유 불변 배열을 쓴다.
const EMPTY_HIDDEN_COMPANION_IDS: readonly string[] = [];

export function OperationsCanvas({
  state,
  catalog,
  canLaunch,
  renderKindIcon,
  onLaunchKind,
  onLaunchAtGeometry,
  onClose,
  onFocus,
  onRename,
  onSetAccent,
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
  const [, setTriageFocusRevision] = useState(0);
  const previousTriageStageRef = useRef<string | null>(null);
  const previousTriageDeckStageRef = useRef<string | null>(null);
  const triageDeckArrivalDwellRef = useRef<TriageDeckArrivalDwell | null>(null);
  const triageStageRectRef = useRef(new Map<string, DOMRect>());
  const triageStageActivityRef = useRef<{
    readonly operationId: string;
    readonly activity: OperationActivity;
  } | null>(null);
  const pendingTriageClearRef = useRef<{
    readonly operationId: string;
    readonly cancel: () => void;
  } | null>(null);
  const autoFocusedTriageStageRef = useRef<TriageStageIdentity | null>(null);
  const companionTriageStageRef = useRef<TriageStageIdentity | null>(null);
  const triageRuntimeRef = useRef<{
    readonly operations: readonly OperationNode[];
    readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  }>({ operations: [], operationStatus: {} });

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
    onClick: clearTerminalFocus,
  });

  const handleContextMenuLaunchKind = (pluginId: string, kind: OperationLaunchKind) => {
    const point = contextMenu?.canvasPoint;
    setContextMenu(null);
    if (!point) return;
    onLaunchKind(pluginId, kind, point);
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest("[data-canvas-blocker], [data-canvas-operation]")) return;
    event.preventDefault();
    // 선별 처리/Formation은 map 좌표가 아닌 고정 배치라 메뉴 앵커를 커서 지점으로 둔다 —
    // canvasPoint는 map 모드에서만 생성/실행 좌표로 쓰인다.
    const anchor = triageActive
      ? { x: event.clientX, y: event.clientY }
      : (() => {
          const rect = canvasRef.current?.getBoundingClientRect();
          return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null;
        })();
    if (!anchor) return;
    setContextMenu({ anchor, canvasPoint: screenToCanvas(anchor, canvas.viewport) });
  };

  const minimizedSet = new Set(minimized);
  const visibleOperations = Object.fromEntries(
    Object.entries(canvas.operations).filter(([sessionId]) => !minimizedSet.has(sessionId)),
  );
  const theaterOperations = (state.operations ?? []).filter((operation) => operation.theaterId === state.activeTheaterId);
  triageRuntimeRef.current = {
    operations: state.operations,
    operationStatus: state.operationStatus,
  };
  // 큐는 전역이다 — 활성 Theater와 무관하게 모든 대기 Operation을 처리 순서로 세운다.
  const triageQueue = resolveTriageQueue(state.operations, state.operationStatus);
  const triageQueueIdSet = new Set(triageQueue.map((entry) => entry.operation.id));
  const triageIdleCount = state.operations.filter((operation) =>
    resolveOperationActivity(operation, state.operationStatus) === "idle"
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
    ? resolveOperationActivity(previousTriageStageOperation, state.operationStatus)
    : null;
  const previousTriageStillWaiting = previousTriageStageOperation !== null
    && isTriageWaitingOperation(previousTriageStageOperation, state.operationStatus);
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
        activity: resolveOperationActivity(graceTriageOperation, state.operationStatus),
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
  const retainedTriageEntry = graceTriageEntry ?? protectedTriageEntry;
  const pickedDifferentOperation = automaticTriageStage?.picked === true
    && automaticTriageStage.operation.id !== retainedTriageEntry?.operation.id;
  const triageDisplayQueue = retainedTriageEntry && !pickedDifferentOperation && automaticTriageStage?.operation.id !== retainedTriageEntry.operation.id
    ? [retainedTriageEntry, ...triageQueue.filter((entry) => entry.operation.id !== retainedTriageEntry.operation.id)]
    : triageQueue;
  const candidateTriageStage = triageActive ? triageDisplayQueue[0] ?? null : null;
  // 선별 처리의 관심사는 살아있는 함대다 — 휴면(dormant) Operation은 deck에 올리지 않는다.
  const triageDeckOperations = triageActive
    ? state.operations.filter((operation) => resolveOperationActivity(operation, state.operationStatus) !== "dormant")
    : theaterOperations;
  const triageDeckOperationIdSet = new Set(triageDeckOperations.map((operation) => operation.id));
  // 입장 연출(triageEntering) 중에는 deck가 아직 안 보이지만 연출이 끝나면 보인다 — 스포트라이트
  // OFF 억제는 이 "보일 상태"(deckAvailable)를 기준으로 해야 진입 순간의 저장된 OFF가 무시되지 않는다.
  const deckAvailable = triageActive
    && previousTriageDeckStageRef.current === null
    && triageDeckOperations.length > 0;
  const deckWasVisible = deckAvailable && !triageEntering;
  const deckPromotion = resolveTriageDeckPromotion({
    operationId: candidateTriageStage?.operation.id ?? null,
    picked: candidateTriageStage?.picked === true,
    deckVisible: deckWasVisible,
    deckAvailable,
    spotlight: triageSpotlightEnabled,
    dwell: triageDeckArrivalDwellRef.current,
    now: Date.now(),
    suppressed: panelMotionSuppressed(),
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
    if (!dwell || triageStageId !== null || panelMotionSuppressed()) return;
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
  // deck는 무대가 떠 있어도 mount를 유지한다(visibility 은닉) — 비무대 body의 거처를 카드
  // 슬롯 하나로 고정해 무대 전환마다 전 세션에 PTY 리사이즈가 퍼지는 churn을 막는다.
  const triageDeckMounted = triageActive && !triageEntering && triageDeckOperations.length > 0;
  // 프리뷰 config의 핸들러는 최신 상태를 ref로 참조한다 — config 객체 identity가 렌더마다 바뀌면
  // pool publish가 매 렌더 revision을 올려 재렌더 루프가 되므로, memo 수명 동안 identity를 고정한다.
  const triagePreviewHandlersRef = useRef({ activate: (_operationId: string) => {}, close: (_operationId: string) => {} });
  triagePreviewHandlersRef.current = {
    activate: (operationId) => {
      pickTriageOperation(operationId);
    },
    close: (operationId) => {
      dismissTriageOperation(operationId);
      if (state.activeOperationId === operationId) setActiveOperation(null);
      onClose(operationId);
    },
  };
  const triagePreviewConfigFor = useMemo(() => {
    if (!triageActive) return undefined;
    const handlers = triagePreviewHandlersRef;
    const configs = new Map<string, OperationBodyConfig>();
    // 선별 중에는 전 Theater가 마운트된다 — 모든 카드가 라이브 프리뷰를 받는다.
    for (const operation of state.operations) {
      // render가 없는 kind는 pool이 body를 만들지 못한다 — 빈 프리뷰 박스 대신 tail 폴백으로 내린다.
      const descriptor = registry.operationKinds.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);
      if (!descriptor?.render) continue;
      configs.set(operation.id, {
        active: false,
        geometry: canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation),
        operation,
        theme: state.activeTheme,
        language,
        zoom: 1,
        onActivate: () => handlers.current.activate(operation.id),
        onClose: () => handlers.current.close(operation.id),
        onGeometryChange: () => {},
        onRequestCompanions: () => {},
        companionsOpen: false,
        hiddenCompanionPanelIds: EMPTY_HIDDEN_COMPANION_IDS,
        onSetCompanionPanelVisible: () => {},
      });
    }
    return (operation: OperationNode) => configs.get(operation.id) ?? null;
  }, [canvas.operations, language, registry.operationKinds, state.activeTheme, state.operations, triageActive]);
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
        || isTriageWaitingOperation(pendingOperation, state.operationStatus)
        || replacedByPick) {
        pendingClear.cancel();
        pendingTriageClearRef.current = null;
        if (replacedByPick) {
          previousTriageStageRef.current = triageStageId;
          triageStageActivityRef.current = triageStage
            ? {
                operationId: triageStage.operation.id,
                activity: resolveOperationActivity(triageStage.operation, state.operationStatus),
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
        const currentActivity = resolveOperationActivity(previousOperation, state.operationStatus);
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
                && !isTriageWaitingOperation(liveOperation, runtime.operationStatus)
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
          activity: resolveOperationActivity(triageStage.operation, state.operationStatus),
        }
      : null;
  }, [state.operations, state.operationStatus, triageActive, triageStage]);
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
  const pluginOperations = foreignStageOperation || foreignCompanionOperation
    ? [
        ...theaterOperations,
        ...(foreignCompanionOperation ? [foreignCompanionOperation] : []),
        ...(foreignStageOperation && foreignStageOperation.id !== foreignCompanionOperation?.id ? [foreignStageOperation] : []),
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
    y: 18,
    width: Math.max(0, canvasSize.width - 36),
    height: Math.max(0, canvasSize.height - 36),
  };
  const allFormationSlots = formationView
    ? calculateGridSlots(
        { x: 0, y: 0, width: canvasSize.width, height: canvasSize.height },
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
    if (!formationView || panelMotionSuppressed()) return;
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
        interaction.onPointerDown(event as Parameters<typeof interaction.onPointerDown>[0]);
      }}
      onPointerMove={interaction.onPointerMove}
      onPointerUp={interaction.onPointerUp}
      onPointerCancel={interaction.onPointerCancel}
      onWheel={interaction.onWheel}
      onContextMenu={handleContextMenu}
      ref={canvasRef}
      tabIndex={-1}
    >
      <CanvasGrid viewport={canvas.viewport} />
      {triageActive ? <div className="canvas-triage-scan" aria-hidden="true" /> : null}
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
        {formationView ? formationGuideSlots.map((geometry, index) => (
          <div
            key={`formation-guide-${formationOperationIds.length + index + 1}`}
            className="canvas-formation-guide"
            style={{
              left: Math.round(geometry.x),
              top: Math.round(geometry.y),
              width: Math.round(geometry.width),
              height: Math.round(geometry.height),
              "--gi": index,
            } as CSSProperties}
            aria-label={t("canvas.formation.slotAria", { index: formationOperationIds.length + index + 1 })}
          >
            <span className="canvas-formation-guide-index">
              {String(formationOperationIds.length + index + 1).padStart(2, "0")}
            </span>
          </div>
        )) : null}
        {pluginOperations.map((operation) => {
          const baseGeometry = canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation);
          const operationMaximized = panelMaximized === operation.id;
          const operationCompanion = panelCompanion === operation.id;
          const operationTriageStage = triageStageId === operation.id;
          // focus layer는 peer를 실제 최소화하지 않고, mount를 보존한 채 렌더만 감춘다.
          const focusLayerHidden = triageActive
            ? !operationTriageStage
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
          // 보더 위 명판(top: -space-3)이 캔버스 상단 클립에 잘리는 뷰포트-상대 위치면 내부 인셋으로 전환한다.
          // 최대화/Formation은 전용 CSS 인셋 규칙이 이미 소유한다.
          const topEdge = !operationTriageStage && !operationMaximized && !operationCompanion && !formationSlot
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
            status: state.operationStatus[operation.id],
            theme: state.activeTheme,
            language,
            viewportZoom: effectiveZoom,
            minimized: triageActive ? !operationTriageStage : minimizedSet.has(operation.id),
            maximized: operationMaximized,
            triageStage: operationTriageStage,
            triagePicked: operationTriageStage && triageStage?.picked === true,
            glanceHud,
            formationSlotIndex: formationView ? formationSlotIndexByOperationId.get(operation.id) : undefined,
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
            bodyYieldedToDeck: triageDeckMounted && triageDeckOperationIdSet.has(operation.id) && !operationTriageStage,
            onRenderHiddenFocus: () => {
              const focusTarget = canvasRef.current?.querySelector<HTMLElement>("[data-focus-layer-target='true']");
              if (focusTarget) {
                focusTarget.focus();
                return;
              }
              canvasRef.current?.focus();
            },
            accentKey: canvas.operationAccent[operation.id] ?? operationAccentFromNode(operation),
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
            onSetAccent: (accentKey) => {
              onSetAccent(operation.id, accentKey);
            },
            onGeometryChange: (geometry) => {
              if (!operationMaximized && !operationCompanion && !formationView && !triageActive) setOperationGeometry(operation.id, geometry);
            },
            onGeometryCommit: (geometry) => {
              if (!operationMaximized && !operationCompanion && !formationView) void updatePluginOperationGeometry(operation.id, getCanvasSnapshot().operations[operation.id] ?? geometry);
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
          <div className="canvas-triage-rail" data-canvas-blocker>
            {triageStage ? (
              <>
                <div className="canvas-triage-rail-current">
                  <span className="canvas-triage-rail-current-label">{t("canvas.triage.railCurrent")}</span>
                  <span aria-hidden="true">▸</span>
                  <span className="canvas-triage-rail-current-name" title={triageStage.operation.title}>{triageStage.operation.title}</span>
                </div>
                <span className="canvas-triage-rail-divider" aria-hidden="true" />
              </>
            ) : null}
            <div className="canvas-triage-rail-next">
              <span className="canvas-triage-rail-lead">{t("canvas.triage.railLead")}</span>
              <span aria-hidden="true">▸</span>
              <div className="canvas-triage-rail-track">
                {triageDisplayQueue.slice(1).length > 0 ? triageDisplayQueue.slice(1).map((entry) => (
                  <button
                    key={entry.operation.id}
                    type="button"
                    className={isTriageWaitingOperation(entry.operation, state.operationStatus) && !isTriageOperationDeferred(entry.operation.id) ? "is-fresh" : undefined}
                    onClick={() => pickTriageOperation(entry.operation.id)}
                  >
                    {entry.operation.title}
                  </button>
                )) : <span className="canvas-triage-rail-empty">{t("canvas.triage.railEmpty")}</span>}
              </div>
            </div>
            <span className="canvas-triage-rail-cleared">{t("canvas.triage.railCleared", { count: getTriageCleared() })}</span>
          </div>
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
        operationStatus={state.operationStatus}
        operationAccent={canvas.operationAccent}
        arrivingOperationId={triageDeckArrivingOperationId}
        stagedOperationId={triageStageId}
        onBeforePick={triageDeckZoom.control.snapZoomTween}
        mapGeometryFor={(operation) => operation.theaterId === state.activeTheaterId
          ? canvas.operations[operation.id] ?? operation.geometry ?? null
          : getTheaterCanvasSnapshot(operation.theaterId).operations[operation.id] ?? operation.geometry ?? null}
        previewConfigFor={triagePreviewConfigFor}
        freshOperationIds={freshDeckOperationIds}
      />
      <TriageClearPlate active={triageActive && triageDeckOperations.length === 0} entering={triageEntering} hasContent={hasContent} idleCount={triageIdleCount} />
      {!triageActive && !hasContent && !formationEntering ? (
        <OperationsCanvasEmptyState
          activeTheaterId={state.activeTheaterId}
          theaterLabel={state.theaters.find((theater) => theater.id === state.activeTheaterId)?.label ?? state.activeTheaterId ?? ""}
          operations={theaterOperations}
          canLaunch={canLaunch}
          onOpenOperation={onFocus}
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
          canLaunch={canLaunch && !formationView && !triageActive}
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

function clearTerminalFocus(): void {
  if (typeof document !== "undefined") {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }
  setActiveOperation(null);
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
    y: 0,
    width: Math.max(320, canvasSize.width),
    height: Math.max(240, canvasSize.height),
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
    y: 0,
    width,
    height: Math.max(0, canvasSize.height),
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
  readonly status?: OperationActivity;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly viewportZoom: number;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly triageStage: boolean;
  readonly triagePicked: boolean;
  readonly glanceHud: GlanceHudModel;
  readonly formationSlotIndex?: number;
  readonly companion: boolean;
  readonly companions: readonly CompanionPanelDescriptor[];
  readonly companionGeometries: readonly OperationGeometry[];
  readonly hiddenCompanionPanelIds: readonly string[];
  readonly formation: boolean;
  readonly focusLayerHidden: boolean;
  readonly operationBodyPoolAvailable: boolean;
  /** Watch Deck가 이 Operation의 body를 카드 프리뷰 슬롯으로 끌어간 동안 프레임은 슬롯을 양보한다. */
  readonly bodyYieldedToDeck: boolean;
  readonly onRenderHiddenFocus: () => void;
  readonly topEdge: boolean;
  readonly accentKey: string | null;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onMinimize: () => void;
  readonly onMaximize: () => void;
  readonly onRename: (title: string) => void;
  readonly onSetAccent: (accentKey: string | null) => void;
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
  return (
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
        glanceHud={options.glanceHud}
        formationSlotIndex={options.formationSlotIndex}
        topEdge={options.topEdge}
        renderHidden={options.focusLayerHidden}
        focusLayerTarget={options.maximized || options.companion}
        interactionDisabled={options.formation || options.companion || options.focusLayerHidden || options.triageStage}
        accentKey={options.accentKey}
        onActivate={options.onActivate}
        onClose={options.onClose}
        onMinimize={options.onMinimize}
        onMaximize={options.onMaximize}
        onRename={options.onRename}
        onSetAccent={options.onSetAccent}
        onGeometryChange={options.onGeometryChange}
        onGeometryCommit={options.onGeometryCommit}
        onRenderHiddenFocus={options.onRenderHiddenFocus}
      >
        {options.operationBodyPoolAvailable ? (
          // Deck 프리뷰가 body를 점유한 동안 프레임 슬롯을 비운다 — 슬롯은 op당 하나만 살아 있어야
          // pool 중재 없이도 결정적으로 이동한다. 프레임 자체는 rect/모션을 위해 mount를 유지한다.
          options.bodyYieldedToDeck ? null : (
          <OperationBodySlot
            operationId={operation.id}
            className="canvas-operation-body-slot"
            config={{
              active: options.active,
              keyboardFocusRequestId: options.keyboardFocusRequestId,
              geometry,
              operation,
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
          )
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
              onActivate={options.onActivate}
              onClose={options.onClose}
              onGeometryChange={options.onGeometryChange}
              onRequestCompanions={onRequestCompanions}
              companionsOpen={options.companion}
              hiddenCompanionPanelIds={options.hiddenCompanionPanelIds}
              onSetCompanionPanelVisible={onSetCompanionPanelVisible}
              render={descriptor.render}
            />
          </PluginErrorBoundary>
        )}
      </OperationFrame>
      {options.companions.map((companion, index) => (
        <CompanionFrame key={companion.id} descriptor={companion} geometry={options.companionGeometries[index]!} language={options.language}>
          <PluginErrorBoundary fallback={<PluginRenderError messageKey="canvas.plugin.companionFailed" />}>
            <PluginOperationRenderer
              active={options.active}
              capabilities={capabilities}
              geometry={geometry}
              operation={operation}
              theme={options.theme}
              language={options.language}
              viewportZoom={options.viewportZoom}
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
  onActivate,
  onClose,
  onGeometryChange,
  onRequestCompanions,
  companionsOpen,
  hiddenCompanionPanelIds,
  onSetCompanionPanelVisible,
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
    status: capabilities.status,
    statusDetail: capabilities.statusDetail,
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

function CompanionFrame({ descriptor, geometry, language, children }: {
  readonly descriptor: CompanionPanelDescriptor;
  readonly geometry: OperationGeometry;
  readonly language: ConsoleLocale;
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
          <span className="canvas-companion-caption-dot" aria-hidden="true" />
          <span className="canvas-companion-caption-title">{title}</span>
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
