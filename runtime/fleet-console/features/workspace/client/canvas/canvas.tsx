import type { OperationActivityVisual } from "../../../execution/client/operation-activity.js";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import { wasOperationBornDormant } from "@fleet-console/sdk/operations/browser";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OperationRuntimeState, CompanionPanelDescriptor, ConsoleTheme, ClientExecutionProvider, OperationKindDescriptor, OperationRenderContext } from "@fleet-console/sdk/plugin";

import { fetchOperations } from "../../../../core/client/src/integration/api.js";
import { claimTheaterBootMinimization } from "../../../../core/client/src/integration/boot-minimization-session.js";
import { availableCompanionPanels, isBlockingDialogOpen } from "../../../../core/client/src/integration/shortcuts.js";
import { clearActiveOperation, isWarRoomEmptyReleaseTarget } from "../../../../core/client/src/integration/active-operation-surface.js";
import { flattenGroupedOrder, focusCycleOperationIds, hydrateOperations, operationOrderFromNodes, requestOperationKeyboardFocus, requestOperationLaunchMenu, resolveOperationGroup, ownOperationRuntime, selectNestedBody, setActiveOperation, setActiveTheater, setOperationOrder } from "../../../../core/client/src/integration/store.js";
import { createHostCapabilities } from "../../../../core/client/src/integration/plugin-capabilities.js";
import { usePluginRegistry } from "../../../../core/client/src/integration/plugin-registry.js";
import { OperationCaptionContributions } from "../operation-contributions.js";
import { ClusterStrip } from "../cluster-strip.js";
import { ClusterPicker } from "../cluster-picker.js";
import { ClusterNodeRail } from "../cluster-node-rail.js";
import { useClusterIndex } from "../operation-clusters.js";
import { useGlobalSettingsStore } from "../../../settings/client/global-settings-store.js";
import { useT, type CoreMessageKey } from "../../../../core/client/src/i18n/index.js";
import { clearIdleArrival, getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/operation-marks.js";
import { pluginRuntimeState, resolveOperationActivity } from "../../../execution/client/operation-activity.js";
import type { ConsoleState, OperationNode } from "../../../../core/client/src/integration/types.js";
import { resolveConsoleLanguage } from "../../../updates/client/whatsnew-i18n.js";
import { OperationBodySlot, useOperationBodyPoolAvailable, type OperationBodyConfig } from "../../../../core/client/src/chrome/mobile/operation-body-pool.js";
import { snapOperationToArenaRect, animateViewportTo, claimTopZIndex, clearCompanionOperationId, clearMaximizedOperationId, consumeAlignOffRestored, consumePendingFitAllOperations, detachAlignAllPanel, enforceStationKeeping, focusOperation, forceDropCompanionOperationId, getCompanionPanelVisibilityOverrides, getSnapshot as getCanvasSnapshot, getTheaterCanvasSnapshot, getTheaterMinimizedIds, minimizeOperation, MIN_OPERATION_HEIGHT, MIN_OPERATION_WIDTH, OPERATION_WINDOW_CAPTION_HEIGHT, prefersReducedMotion, reconcileAlignAll, rejoinAlignAllPanel, releaseSnapHold, releaseSnapHoldOperation, resetCanvasViewportSize, restoreOperation, setCanvasViewportSize, setCompanionOperationId, setCompanionPanelVisible, setMaximizedOperationId, setOperationGeometry, setSnapHoldZones, setTheaterOperationMinimized, settleOperationGeometry, setViewport, syncSnapHoldGeometry, useCanvasState, useCompanionOperationId, useCompanionPanelVisibilityOverrides, useMaximizedOperationId, useMinimized, type CanvasArenaInsets, type CanvasWorldRect, type OperationGeometry } from "./canvas-store.js";
import { escapeSelectorValue, flightTiming, flyPanelBetweenRects, flyPanelMotionGhost, playMinimizeFlight } from "./panel-motion.js";
import { CanvasContextMenu } from "./canvas-context-menu.js";
import { CanvasMinimap } from "./canvas-minimap.js";
import { resolveAccentColor } from "./operation-accent.js";
import { CanvasGrid, ModeTitle, RubberBand, TriageClearPlate } from "./canvas-overlays.js";
import { flashTriageDeckCard, getTriageDeckCardRect, resolveTriageDeckPromotion, takeTriageDeckDepartureRect, TriageWatchDeck, useTriageDeckZoomControl, type TriageDeckArrivalDwell } from "./triage-watch-deck.js";
import { resolveGlanceHudModel, type GlanceHudModel } from "./glance-hud.js";
import type { GroupContextMenuAlign } from "./group-context-menu.js";
import { FleetMap } from "./fleet-map.js";
import { anchorViewportToPoint, resolveFleetContentCenter, resolveFleetMapActive, resolveFleetMapZoomAnchor } from "./fleet-map-layout.js";
import { OperationFrame, type OperationDragPointer } from "./operation-frame.js";
import { SNAP_FULL_ZONES, SNAP_MIN_ZOOM, SNAP_PRESETS, SNAP_TOP_FULL_EDGE, evenAlignBodies, snapEdgeHitFor, snapEmptyZoneHitFor, snapPointAtTopEdge, snapPointInRect, snapPointInTopBand, snapZoneHitFor, snapZonesFor, snapZonesResized, type SnapRect, type SnapZoneHit, type SnapZoneSet } from "./snap-layouts.js";
import { SnapAssist, SnapGhost, SnapHandle, SnapLayoutBar, SnapLayoutMenu, type SnapAssistCandidate, type SnapZoneRef } from "./snap-layouts-ui.js";
import { hasVisibleCanvasContent, OperationsCanvasEmptyState } from "./operations-canvas-empty-state.js";
import { useCanvasInteraction } from "./use-canvas-interaction.js";
import { screenToCanvas, triageStageGeometryFor, type CanvasPoint, type CanvasRect } from "./coordinates.js";
import { companionSlotWeightsFor, COMPANION_CRAMPED_SLOT_RATIO, COMPANION_KEYBOARD_STEP_PX, COMPANION_MIN_SLOT_PX, COMPANION_SESSION_SLOT_ID, COMPANION_SLOT_GAP_PX, resetCompanionSlotWeights, resolveCompanionSlotWidths, setCompanionSlotWeights, useCompanionSlotWeights } from "./companion-widths.js";
import { disarmTriageSetAside, dismissTriageOperation, forgetTriageOperation, getTriageEnteredAt, getTriagePick, getTriageSetAsideArmedId, getTriageSnapshot, isTriageActive, isTriageClearedTransition, isTriageOperationDeferred, isTriageOperationDismissed, isTriageWaitingOperation, pickTriageOperation, reconcileTriageStageCompanion, recordTriageStageTheater, resolveActiveAwaitingTriageEntry, resolveTriageQueue, scheduleTriageClear, subscribeTriage, useTriageActive, useTriageSpotlightEnabled, type TriageQueueEntry, type TriageStageIdentity } from "./triage-store.js";

// 함대 지도 퇴장 연출 길이 — CSS fleet-map-out(--duration-base ≈ 220ms)보다 넉넉히.
const FLEET_MAP_LEAVE_MS = 320;
// 모드 전환 제목(킥커·제목·설명)이 서 있는 길이. 패널 glide(--duration-slow + 슬롯 stagger)와
// 제목의 낱말 진입·퇴장이 모두 이 안에서 끝난다 — CSS의 mode-title 키프레임 길이와 같은 값.
const MODE_TITLE_DURATION_MS = 1_350;
// 모드 전환 flight의 슬롯 stagger와 출발 rect의 유효 기간 — 덱 칸은 슬롯 등록 뒤 두 번째 커밋에서야
// 패널을 받으므로, 첫 커밋에서 못 날린 패널을 다음 커밋까지 기다린다.
const MODE_FLIGHT_STAGGER_MS = 40;
const MODE_FLIGHT_WINDOW_MS = 400;

interface OperationsCanvasProps {
  readonly state: ConsoleState;
  /** 전면 캔버스 위 부유 크롬(사이드바·레일 카드)이 가리는 가장자리 — 아레나 계산의 원료. */
  readonly arenaInsets: CanvasArenaInsets;
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly canLaunch: boolean;
  readonly renderKindIcon: (pluginId: string | null, kind: OperationLaunchKind) => ReactNode;
  readonly onLaunchKind: (pluginId: string | null, kind: OperationLaunchKind, canvasPoint: CanvasPoint, theaterId?: string, variant?: Readonly<Record<string, string>>) => void;
  readonly onLaunchAtGeometry: (pluginId: string | null, kind: OperationLaunchKind, geometry: OperationGeometry) => void;
  readonly onRefreshCatalog?: () => void;
  readonly onClose: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  /** 빈 캔버스의 일괄 열기 — 대기 목록에 보인 순서(updatedAt 내림차순) 그대로 id를 넘긴다. */
  readonly onOpenAll: (operationIds: readonly string[]) => void;
  readonly onRename: (operationId: string, title: string) => void;
  readonly onOpenOperationMenu?: (operationId: string, anchor: DOMRect, returnFocus?: HTMLElement | null, align?: GroupContextMenuAlign) => void;
  // 지금 메뉴가 열린 Operation — 그 패널의 More 버튼만 열림 상태를 말한다.
  readonly openMenuOperationId?: string | null;
  /** 그 Operation의 패널이 focus layer 뒤로 숨었다 — 그 패널이 주인인 메뉴가 열려 있으면 거둔다. */
  readonly onDismissOperationMenu?: (operationId: string) => void;
  /** 정렬 중 안내(그룹 경계 거부 등) — 호출부(Operations)가 토스트로 띄운다. */
  readonly onAlignNotice: (key: CoreMessageKey) => void;
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
   스냅·정렬 칸도 같은 상수로 캡션 띠를 뺀다. */
const TITLEBAR_OUTSET_PX = OPERATION_WINDOW_CAPTION_HEIGHT;
// 프리뷰 config는 identity 비교로 재발행이 억제되므로 공유 불변 배열을 쓴다.
const EMPTY_HIDDEN_COMPANION_IDS: readonly string[] = [];

export function OperationsCanvas({
  state,
  arenaInsets,
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
  openMenuOperationId = null,
  onDismissOperationMenu,
  onAlignNotice,
}: OperationsCanvasProps) {
  const canvasRef = useRef<HTMLElement | null>(null);
  // 캡션·companion의 API 의존 effect가 메뉴·기하 변경마다 재시작되지 않게 수명을 Canvas에 묶는다.
  const capabilities = useMemo(() => createHostCapabilities(() => {
    void fetchOperations(null).then(hydrateOperations).catch(() => {});
  }), []);
  const t = useT();
  const canvas = useCanvasState();
  // ── Cruise 스냅 상태 ─────────────────────────────────────────────────────
  // 손잡이·바·고스트·메뉴는 모두 화면(캔버스 박스) 좌표다 — 칸은 지금 보이는 아레나의 것이라 카메라와 무관하다.
  const [snapDragging, setSnapDragging] = useState(false);
  const [snapBar, setSnapBar] = useState<{ readonly open: boolean; readonly hover: SnapZoneRef | null; readonly full: boolean }>({ open: false, hover: null, full: false });
  const [snapGhost, setSnapGhost] = useState<SnapRect | null>(null);
  const [snapMenu, setSnapMenu] = useState<{ readonly operationId: string; readonly anchor: SnapRect } | null>(null);
  const snapBarRef = useRef<HTMLDivElement | null>(null);
  const snapDragRef = useRef<{ operationId: string; barOpen: boolean; zone: SnapZoneHit | null; alignSwapId: string | null; alignJoin: boolean } | null>(null);
  // Snap Assist — 스냅 직후 빈 칸이 후보를 권한다. 열림 여부만 상태다; 어느 칸이 비었는지는 렌더가 유지에서 읽는다.
  // 모두 정렬에는 빈칸이 없어 판이 열리지 않는다.
  const [snapAssist, setSnapAssist] = useState(false);
  const alignMeta = canvas.snapHold?.alignAll ?? null;
  const alignOn = alignMeta !== null;
  const maximizedOperationId = useMaximizedOperationId();
  const companionOperationId = useCompanionOperationId();
  const companionPanelVisibilityOverrides = useCompanionPanelVisibilityOverrides(companionOperationId);
  const companionSlotWeights = useCompanionSlotWeights();
  // 분할선 제스처는 렌더 트리 밖(포인터 리스너)에서 폭을 읽는다 — 시작 시점의 값으로 굳히면
  // 끌던 중 창이 바뀔 때 이전 좌표계로 계속 자른다.
  const companionSlotIdsRef = useRef<readonly string[]>([]);
  const companionSlotWidthsRef = useRef<readonly number[]>([]);
  const lastValidCompanionRef = useRef<{ readonly operation: OperationNode; readonly descriptor: OperationKindDescriptor } | null>(null);
  const minimized = useMinimized();
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const activePluginOperationId = state.activeOperationId;
  // ── 묶음 ────────────────────────────────────────────────────────────────
  // 구성원은 어느 모드에서도 패널로 서지 않는다 — 스토어의 기본 목록에 없고, 지휘관 패널이 본문 교체로 보여 준다.
  // 구성원을 가리킨 포커스(목표의 「결정 대기」·팔레트·알림)도 스토어가 지휘관으로 돌리며 본문을 그 구성원으로 바꾼다.
  // 묶음 색인은 띠·노드 줄·피커를 그리는 데만 쓴다.
  const clusterIndex = useClusterIndex();
  // 지휘관의 공개 활동은 코어 스토어가 살아 있는 구성원까지 반영한다 — 구성원의 결정 대기도 지휘관을 대기로 올린다.
  const operationRuntime = state.operationRuntime;
  const [focusFadeTransitionReady, setFocusFadeTransitionReady] = useState(activePluginOperationId !== null);
  const [contextMenu, setContextMenu] = useState<ContextMenuRequest | null>(null);
  const registry = usePluginRegistry();
  const notifyMapOperationSelected = useCallback((operationId: string) => {
    for (const provider of registry.providers) {
      provider.onMapOperationSelected?.(operationId);
    }
  }, [registry.providers]);
  const globalSettings = useGlobalSettingsStore();
  const language = resolveConsoleLanguage(globalSettings.state?.language ?? "auto");
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const glanceVisible = useGlanceHold();
  const disabled = !state.activeTheaterId || state.addingTheater;
  const operationBodyPoolAvailable = useOperationBodyPoolAvailable();
  const triageActive = useTriageActive();
  const clusterBodySelection = state.nestedBodySelection;
  const [clusterPicker, setClusterPicker] = useState<{
    readonly rootId: string;
    readonly anchor: DOMRect;
    readonly canvasTop?: number;
    readonly targetOperationId?: string;
    readonly panelRect?: { readonly left: number; readonly top: number; readonly width: number; readonly height: number; readonly bottom: number };
  } | null>(null);
  const triageSpotlightEnabled = useTriageSpotlightEnabled();
  useSyncExternalStore(subscribeTriage, getTriageSnapshot, getTriageSnapshot);
  const triageDeckZoom = useTriageDeckZoomControl();
  const [triageEntering, setTriageEntering] = useState(false);
  const [, setTriageDeckDwellRevision] = useState(0);
  // 모두 정렬 진입 제목 — 같은 세 줄(SNAP / 모두 정렬 / N개 배치)로 도착을 선언한다.
  const [alignEntering, setAlignEntering] = useState(false);
  const [cruiseEntering, setCruiseEntering] = useState(false);
  const previousCanvasModeRef = useRef<"cruise" | "align" | "warRoom" | null>(null);
  // 정렬 해제로 Cruise에 돌아왔는가 — 명시적 끄기(자리 복원)일 때만 끄기 제목을 띄운다.
  const cruiseReturnFromAlignRef = useRef(false);
  const [, setTriageFocusRevision] = useState(0);
  const previousTriageStageRef = useRef<string | null>(null);
  const previousTriageDeckStageRef = useRef<string | null>(null);
  const triageDeckArrivalDwellRef = useRef<TriageDeckArrivalDwell | null>(null);
  const triageStageRectRef = useRef(new Map<string, DOMRect>());
  // War Room 진입·이탈 flight — 패널이 덱 칸으로 portal 재부모화되면 left/top 전이가 끊기므로,
  // 스토어가 바뀐 직후(렌더 전) 화면 rect를 잡아 두고 커밋 뒤 FLIP으로 실제 패널을 옮긴다.
  const modeFlightRef = useRef<{ readonly from: Map<string, DOMRect>; readonly flown: Set<string>; readonly deadline: number } | null>(null);
  const renderedTriageActiveRef = useRef(triageActive);
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
  // 함대 지도 판정의 직전 값 — 히스테리시스의 기억이자, 제스처 훅이 "지금 판 위인가"를 읽는 채널.
  const fleetMapActiveRef = useRef(false);

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
    // 전환 제목은 전역 진입 시각 기준으로 한 번만 띄운다 — 선별 중 Theater 자동 전환은 재생하지 않는다.
    const enteredAt = getTriageEnteredAt() ?? Date.now();
    const remaining = Math.max(0, MODE_TITLE_DURATION_MS - (Date.now() - enteredAt));
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
    if (!alignOn || !state.activeTheaterId) {
      setAlignEntering(false);
      return;
    }
    setAlignEntering(true);
    const timer = window.setTimeout(() => {
      setAlignEntering(false);
    }, MODE_TITLE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [alignOn, state.activeTheaterId]);

  // 모드 이탈도 진입과 같은 무게로 알린다 — 명시적 끄기(자리 복원)의 복귀 역시 같은 세 줄로 도착을 선언한다.
  // 줌·fit-all·Station Keeping 해제는 조용히 풀린다.
  useEffect(() => {
    const mode = triageActive ? "warRoom" : alignOn ? "align" : "cruise";
    const previousMode = previousCanvasModeRef.current;
    previousCanvasModeRef.current = mode;
    if (mode !== "cruise") {
      // 정렬↔War Room 직접 전환은 그 모드의 제목이 소유한다 — 남은 복귀 제목을 즉시 걷는다.
      setCruiseEntering(false);
      return;
    }
    // 첫 마운트가 Cruise인 것은 복귀가 아니다.
    if (previousMode === null || previousMode === "cruise") return;
    // Station Keeping이 켜져 있으면 모드 밖에서 생긴 겹침(War Room 지도 이동 등)을 복귀 시점에 정착시킨다.
    enforceStationKeeping();
    if (previousMode === "align") {
      cruiseReturnFromAlignRef.current = true;
      // 자리 복원 없이 풀렸으면 제목을 띄우지 않는다.
      if (!consumeAlignOffRestored()) return;
    } else {
      cruiseReturnFromAlignRef.current = false;
    }
    setCruiseEntering(true);
    const timer = window.setTimeout(() => setCruiseEntering(false), MODE_TITLE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [alignOn, triageActive]);

  // 포커스 레이어(최대화·companion)가 걷힌 순간 Cruise 규율을 재적용한다 — 드래그 도중 레이어 전환은
  // 드래그를 커밋 없이 중단시키므로(operation-frame의 interaction-disabled 정리), 라이브 좌표가 겹친 채
  // 남을 수 있다. 정착은 커밋에만 걸려 있어 이 재적용이 그 구멍을 막는다. 규율이 꺼져 있으면 no-op.
  const focusLayerActive = maximizedOperationId !== null || companionOperationId !== null;
  useEffect(() => {
    if (focusLayerActive || triageActive) return;
    enforceStationKeeping();
  }, [focusLayerActive, triageActive]);

  // ── 아레나 좌표계 ──────────────────────────────────────────────────────────
  // 전면 캔버스에서 저장된 viewport/geometry는 아레나-상대 좌표를 유지한다(무마이그레이션 계약).
  // 화면 변환에는 아레나 원점을 더한 screenViewport를 쓰고, 제스처가 돌려준 값에서는 도로 빼서
  // 스토어에 넣는다. 사이드바 접힘·레일 개폐로 아레나 원점이 움직이면 콘텐츠가 그에 따라
  // 흐른다 — 도킹 시절 스테이지 원점이 움직이던 것과 같은 문법이다.
  const arena = {
    x: arenaInsets.left,
    y: arenaInsets.top,
    width: Math.max(0, canvasSize.width - arenaInsets.left - arenaInsets.right),
    height: Math.max(0, canvasSize.height - arenaInsets.top - arenaInsets.bottom),
  };
  // 모드 프레임은 가로로 부유 카드에 8px까지 다가선다(components.css .canvas-mode-frame:
  // max(10px, 아레나 − 4px)). 정렬·War Room의 칸 배치가 아레나에 머물면 프레임만
  // 다가서고 패널이 따라오지 못해 내부 리듬(프레임↔패널 8px)이 깨진다 — 18px 인셋을 쓰는
  // 모드 소비자에게는 가로만 14px 되물린 아레나를 준다: max(0, 인셋−14)+18 = max(18, 인셋+4)
  // = 프레임 변 + 8. 크롬이 접힌 변은 인셋 0이라 기존 18px가 그대로 남는다.
  const modeArenaLeft = Math.max(0, arenaInsets.left - 14);
  const modeArenaRight = Math.max(0, arenaInsets.right - 14);
  const modeArena = {
    x: modeArenaLeft,
    y: arena.y,
    width: Math.max(0, canvasSize.width - modeArenaLeft - modeArenaRight),
    height: arena.height,
  };
  const screenViewport = {
    x: canvas.viewport.x + arena.x,
    y: canvas.viewport.y + arena.y,
    zoom: canvas.viewport.zoom,
  };
  const storedViewportFromScreen = useCallback((viewport: { readonly x: number; readonly y: number; readonly zoom: number }) => ({
    x: viewport.x - arenaInsets.left,
    y: viewport.y - arenaInsets.top,
    zoom: viewport.zoom,
  }), [arenaInsets.left, arenaInsets.top]);

  const interaction = useCanvasInteraction({
    viewport: screenViewport,
    // companion·War Room은 자기 판이라 캔버스 제스처를 통째로 게이트한다 — 슬롯 사이 빈 공간에서
    // 숨은 viewport를 팬/줌하거나 오래된 월드 좌표로 생성하는 일이 없게 한다.
    // 모두 정렬은 Cruise 위의 유지라 끌기·팬·줌을 허용한다(줌은 유지를 푼다).
    disabled: disabled || companionOperationId !== null || triageActive,
    onViewportChange: (viewport) => {
      setClusterPicker(null);
      setViewport(storedViewportFromScreen(viewport));
    },
    onZoom: (viewport, screen) => {
      setClusterPicker(null);
      // 줌은 유지를 푼다 — 카메라를 움직이려는 첫 의도다. 패널은 그 자리에 자유 패널로 남는다.
      releaseSnapHold();
      // 판 위의 줌은 커서 아래 월드가 아니라 커서가 겨눈 점을 앵커로 잡는다 — 판 위의 커서는
      // 월드와 무관해, 그대로 앵커하면 함대가 화면 밖에 남은 채 패널이 돌아온다. 판은 함대의
      // 축소판이므로 커서에 가장 가까운 점의 Operation을 커서 아래 두고 키운다: 판이 걷힌 뒤에도
      // 같은 커서 앵커로 그 패널이 자라, "지도에서 겨눈 곳으로 내려간다"가 한 제스처로 이어진다.
      // 활성 Theater에 점이 없으면 함대 중심을 아레나 중앙에 둔다.
      if (fleetMapActiveRef.current) {
        const snapshot = getCanvasSnapshot();
        const canvasRect = canvasRef.current?.getBoundingClientRect();
        const candidates = canvasRect
          ? [...(canvasRef.current?.querySelectorAll<HTMLElement>("[data-fleet-map-dot]") ?? [])].flatMap((dot) => {
              const operationId = dot.dataset.fleetMapDot;
              const operation = operationId ? state.operations.find((candidate) => candidate.id === operationId) : undefined;
              const geometry = operationId ? snapshot.operations[operationId] : undefined;
              if (!operation || !geometry || operation.theaterId !== state.activeTheaterId || snapshot.minimized.includes(operation.id)) return [];
              const rect = dot.getBoundingClientRect();
              return [{
                operationId: operation.id,
                screen: { x: rect.left + rect.width / 2 - canvasRect.left, y: rect.top + rect.height / 2 - canvasRect.top },
                center: { x: geometry.x + geometry.width / 2, y: geometry.y + geometry.height / 2 },
              }];
            })
          : [];
        const target = resolveFleetMapZoomAnchor(candidates, screen);
        if (target) {
          animateViewportTo(anchorViewportToPoint(target.center, viewport.zoom, arena, { x: screen.x - arena.x, y: screen.y - arena.y }));
          return;
        }
        const center = resolveFleetContentCenter(snapshot.operations, snapshot.minimized);
        if (center) {
          animateViewportTo(anchorViewportToPoint(center, viewport.zoom, arena));
          return;
        }
      }
      animateViewportTo(storedViewportFromScreen(viewport));
    },
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

  // 무포커스 → 첫 포커스에서는 곁의 모든 본문이 한꺼번에 220ms opacity 합성을 시작하지 않게
  // 한 페인트 동안만 전환을 닫는다. A → B 이동은 이미 후퇴한 패널과 새 도착지 두 곳만 바뀌므로
  // 기존 모션을 유지한다. 포커스가 다시 비면 다음 첫 진입을 위해 재무장한다.
  useEffect(() => {
    if (activePluginOperationId === null) {
      setFocusFadeTransitionReady(false);
      return;
    }
    if (focusFadeTransitionReady) return;
    const frame = window.requestAnimationFrame(() => setFocusFadeTransitionReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, [activePluginOperationId, focusFadeTransitionReady]);

  // 우클릭 가드는 다음 우클릭에서만 돈다. 마지막 Theater를 잊는 동안 이미 열린 상자는
  // 목록이 비워져도 그대로 남으므로, 그 전환에서 걷는다.
  useEffect(() => {
    if (state.theaters.length === 0) setContextMenu(null);
  }, [state.theaters.length]);

  // 아레나 원점이 움직이면(사이드바 접기 등) 열려 있던 실행 메뉴의 화면 앵커와 열 때 환산한
  // 월드 좌표가 벌어진다 — 실행이 메뉴 밑이 아니라 옛 지점에 떨어지므로 메뉴를 걷는다(적대 리뷰).
  useEffect(() => {
    setContextMenu(null);
  }, [arenaInsets.left, arenaInsets.top]);

  const handleContextMenuLaunchKind = (
    pluginId: string | null,
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
    // 표시는 Console 뷰포트, 실행 위치는 캔버스 월드 좌표다 — 부유 크롬은 메뉴의 경계가 아니다.
    setContextMenu({
      anchor: { x: event.clientX, y: event.clientY },
      canvasPoint: screenToCanvas(anchor, screenViewport),
    });
    onRefreshCatalog?.();
  };

  const openTriageTheaterLaunchMenu = (theaterId: string, cursor: CanvasPoint) => {
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    if (!canvasRect) return;
    const local = { x: cursor.x - canvasRect.left, y: cursor.y - canvasRect.top };
    setContextMenu({
      anchor: cursor,
      // 실행 좌표는 그 Theater의 world 좌표여야 한다 — canvasPointToGeometry는 받은 점을 world로
      // 취급한다. War Room은 전 Theater를 한 판에 얹으므로 화면-local을 그대로 넘기면 그 Theater를
      // 다시 열었을 때 패널이 보이는 자리 밖에 놓인다. 로드된 Theater가 아닐 수 있으니 저장된
      // 스냅샷의 뷰포트로 환산한다. 저장 viewport는 아레나-상대이므로 아레나 원점을 더해 환산한다.
      canvasPoint: screenToCanvas(local, {
        x: getTheaterCanvasSnapshot(theaterId).viewport.x + arena.x,
        y: getTheaterCanvasSnapshot(theaterId).viewport.y + arena.y,
        zoom: getTheaterCanvasSnapshot(theaterId).viewport.zoom,
      }),
      theaterId,
    });
    onRefreshCatalog?.();
  };

  const minimizedSet = new Set(minimized);
  // 휴면으로 태어난 Operation은 좌표를 심는 effect보다 첫 렌더가 먼저 오므로, 좌표가 아직 없으면 최소화된 것으로 본다 —
  // 그 effect가 좌표와 최소화를 함께 확정할 때까지 한 프레임도 펼쳐 그리지 않는다.
  for (const operation of state.operations ?? []) {
    if (operation.theaterId === state.activeTheaterId && !(operation.id in canvas.operations) && wasOperationBornDormant(operation.payload)) minimizedSet.add(operation.id);
  }
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
    operationRuntime: operationRuntime,
  };
  // 큐는 전역이다 — 활성 Theater와 무관하게 모든 대기 Operation을 처리 순서로 세운다.
  // 구성원은 기본 목록에 없어 큐에 들지 않는다: War Room 에서는 구성원 활동이 반영된 지휘관이 묶음을 대표한다.
  const triageOperations = state.operations;
  const triageQueue = resolveTriageQueue(triageOperations, operationRuntime);
  const triageQueueIdSet = new Set(triageQueue.map((entry) => entry.operation.id));
  const triageIdleCount = triageOperations.filter((operation) =>
    resolveOperationActivity(operation, operationRuntime) === "idle"
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
    ? resolveOperationActivity(previousTriageStageOperation, operationRuntime)
    : null;
  const previousTriageStillWaiting = previousTriageStageOperation !== null
    && isTriageWaitingOperation(previousTriageStageOperation, operationRuntime);
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
        activity: resolveOperationActivity(graceTriageOperation, operationRuntime),
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
  const activeAwaitingTriageEntry = resolveActiveAwaitingTriageEntry(triageOperations, operationRuntime);
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
    ? state.operations.filter((operation) => resolveOperationActivity(operation, operationRuntime) !== "ended"
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
  // Snap Assist의 칸도 같은 자리 계약이다 — 후보 Operation의 실제 패널이 그 칸으로 portal된다.
  const snapAssistSlotsRef = useRef(new Map<string, HTMLElement>());
  const [snapAssistSlots, setSnapAssistSlots] = useState<ReadonlyMap<string, HTMLElement>>(() => new Map());
  const registerSnapAssistSlot = useCallback((operationId: string, element: HTMLElement | null) => {
    const slots = snapAssistSlotsRef.current;
    if (element) {
      if (slots.get(operationId) === element) return;
      slots.set(operationId, element);
    } else if (!slots.delete(operationId)) return;
    setSnapAssistSlots(new Map(slots));
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
    renderedTriageActiveRef.current = triageActive;
  }, [triageActive]);
  useEffect(() => subscribeTriage(() => {
    // 스토어 리스너는 React 커밋 전에 동기로 불린다 — 아직 옛 자리에 서 있는 패널의 rect가 출발점이다.
    if (isTriageActive() === renderedTriageActiveRef.current || prefersReducedMotion()) return;
    const root = canvasRef.current;
    if (!root) return;
    const from = new Map<string, DOMRect>();
    for (const element of root.querySelectorAll<HTMLElement>(".canvas-operation[data-operation-id]")) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(element).visibility === "hidden") continue;
      from.set(element.dataset.operationId!, rect);
    }
    modeFlightRef.current = from.size > 0 ? { from, flown: new Set(), deadline: performance.now() + MODE_FLIGHT_WINDOW_MS } : null;
  }), []);
  useLayoutEffect(() => {
    const flight = modeFlightRef.current;
    const root = canvasRef.current;
    if (!flight || !root) return;
    if (performance.now() > flight.deadline) {
      modeFlightRef.current = null;
      return;
    }
    const timing = flightTiming();
    let flown = 0;
    for (const element of root.querySelectorAll<HTMLElement>(".canvas-operation[data-operation-id]")) {
      const operationId = element.dataset.operationId!;
      const from = flight.from.get(operationId);
      if (!from || flight.flown.has(operationId)) continue;
      const to = element.getBoundingClientRect();
      if (to.width <= 0 || to.height <= 0 || getComputedStyle(element).visibility === "hidden") continue;
      flight.flown.add(operationId);
      if (flyPanelBetweenRects(element, from, to, timing, flown * MODE_FLIGHT_STAGGER_MS)) flown += 1;
    }
    if (flight.flown.size >= flight.from.size) modeFlightRef.current = null;
    // 덱 격자는 스크롤 포트라 칸보다 큰 출발 상자를 잘라낸다 — 비행하는 동안만 클립을 푼다.
    const grid = root.querySelector<HTMLElement>(".canvas-triage-deck-grid");
    if (grid && flown > 0) {
      grid.classList.add("is-mode-flight");
      window.setTimeout(() => grid.classList.remove("is-mode-flight"), timing.duration + flown * MODE_FLIGHT_STAGGER_MS + 40);
    }
  });
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
        || isTriageWaitingOperation(pendingOperation, operationRuntime)
        || replacedByPick) {
        pendingClear.cancel();
        pendingTriageClearRef.current = null;
        if (replacedByPick) {
          previousTriageStageRef.current = triageStageId;
          triageStageActivityRef.current = triageStage
            ? {
                operationId: triageStage.operation.id,
                activity: resolveOperationActivity(triageStage.operation, operationRuntime),
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
        const currentActivity = resolveOperationActivity(previousOperation, operationRuntime);
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
          activity: resolveOperationActivity(triageStage.operation, operationRuntime),
        }
      : null;
  }, [state.operations, operationRuntime, triageActive, triageStage]);
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
  // ── 함대 지도 ─────────────────────────────────────────────────────────────
  // Cruise가 판독 한계 아래로 축소되면 패널 대신 함대 지도가 선다. 판정은 히스테리시스라 직전 값을
  // ref가 들고, 모드·포커스 층이 서 있는 동안은 항상 꺼진다 — 그 층들은 자기 기하를 쓰므로 줌이
  // 무엇이든 지도가 끼어들 자리가 없다. 렌더 중 ref 갱신은 같은 줌에 같은 답을 내는 순수 판정이라
  // 재렌더에 안전하다. 지도는 전 Theater를 얹으므로 최소화 판정도 Theater 경계를 넘는다.
  const cruiseSurface = !triageActive && panelMaximized === null && panelCompanion === null && !disabled;
  const fleetMapMinimizedSet = new Set(getTheaterMinimizedIds(state.theaters.map((theater) => theater.id)));
  const fleetMapOperations = state.operations.filter((operation) => !fleetMapMinimizedSet.has(operation.id));
  fleetMapActiveRef.current = cruiseSurface && fleetMapOperations.length > 0
    && resolveFleetMapActive(fleetMapActiveRef.current, canvas.viewport.zoom);
  const fleetMapActive = fleetMapActiveRef.current;

  // ── Cruise 스냅 ──────────────────────────────────────────────────────────
  // 스냅은 Cruise의 자유 배치 위에서만 산다. War Room·최대화·companion은 프레임 드래그
  // 자체가 잠겨 바가 뜰 경로가 없지만, 캡션 메뉴는 명시적으로 닫는다. Fleet Map(줌 < 0.2)에서는
  // 패널이 지도 점이라 스냅 대상이 아니다. 모두 정렬 중에는 바·핫존이 쉬고 칸 교환·다시 넣기·빼내기만
  // 동작한다(아래 정렬 드롭 분기).
  const snapEnabled = !triageActive && panelMaximized === null && panelCompanion === null && canvas.viewport.zoom >= SNAP_MIN_ZOOM;
  // 칸의 기준 상자는 스냅·정렬이 함께 쓰는 모드 아레나(아레나-상대)다 — 부유 카드에서 8px 떨어져 선다.
  const snapHitArena: SnapRect = { x: 0, y: 0, width: arena.width, height: arena.height };
  // 손잡이 폭 — 아레나 절반(360~760px). 바를 내리는 띠도 이 폭 안에서만 반응한다.
  const snapHandleWidth = Math.max(360, Math.min(760, Math.round(arena.width * 0.5)));
  // 칸은 이 렌더의 인셋 prop(modeArena)에서 바로 편다 — 스토어의 인셋은 passive effect가 뒤늦게 갱신하므로,
  // 사이드바를 여닫은 직후 렌더에서 스토어를 읽으면 이전 크롬 폭의 칸이 나온다.
  const snapArena: SnapRect = { x: modeArena.x - arena.x, y: 0, width: modeArena.width, height: arena.height };
  const arenaRectToBox = (rect: SnapRect): SnapRect => ({ x: rect.x + arena.x, y: rect.y + arena.y, width: rect.width, height: rect.height });
  const frameOf = (body: SnapRect): SnapRect => ({ x: body.x, y: body.y - OPERATION_WINDOW_CAPTION_HEIGHT, width: body.width, height: body.height + OPERATION_WINDOW_CAPTION_HEIGHT });
  // ── 스냅 유지 ──
  // 유지 패널은 저장된 월드 좌표가 아니라 "지금 보이는 아레나"의 칸에서 매 렌더 편다 — 사이드바·레일이
  // 여닫히거나 카메라가 팬해도 칸에 붙어 있다. 편 값은 effect가 스토어에 되써서 영속·Station Keeping·
  // 해제가 같은 좌표를 본다. War Room·최대화·Fleet Map은 자기 기하로 덮으므로 여기서는 쉰다.
  // 모두 정렬도 같은 파이프를 탄다 — 칸·할당이 자동 채움일 뿐이다.
  const snapHold = canvas.snapHold;
  const snapHoldActive = snapEnabled && !fleetMapActive && snapHold !== null;
  const snapHoldSet: SnapZoneSet | null = snapHold ? { id: snapHold.presetId, zones: snapHold.zones } : null;
  const snapHoldBodies = snapHoldActive && snapHoldSet ? snapZonesFor(snapArena, snapHoldSet) : [];
  // 정렬 칸은 줄·열 안에서 폭·높이를 균등 분배한다 — 반간격 배분 탓에 가장자리 칸이 4px씩 넓어지는 것을 고친다.
  // 수동 스냅 본문은 그대로 둔다.
  const alignBodies = alignMeta ? evenAlignBodies(snapHoldBodies) : snapHoldBodies;
  const snapHoldTakenExcept = (operationId: string | null): ReadonlySet<number> =>
    new Set(Object.entries(snapHold?.assignments ?? {}).filter(([id]) => id !== operationId).map(([, index]) => index));
  const snapHoldWorldRect = (zoneIndex: number): CanvasWorldRect | null => {
    const body = (alignMeta ? alignBodies : snapHoldBodies)[zoneIndex];
    if (!body) return null;
    const zoom = canvas.viewport.zoom;
    return { x: (body.x - canvas.viewport.x) / zoom, y: (body.y - canvas.viewport.y) / zoom, width: body.width / zoom, height: body.height / zoom };
  };
  const snapHoldEntries = snapHoldActive && snapHold
    ? Object.entries(snapHold.assignments).flatMap(([sessionId, zoneIndex]) => { const rect = snapHoldWorldRect(zoneIndex); return rect ? [{ sessionId, rect }] : []; })
    : [];
  const snapHoldSyncKey = snapHoldEntries.map(({ sessionId, rect }) => `${sessionId}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`).join("|");
  useEffect(() => {
    if (snapHoldEntries.length > 0) syncSnapHoldGeometry(snapHoldEntries);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapHoldSyncKey]);
  const closeSnapAssist = useCallback(() => setSnapAssist(false), []);
  // 후보 카드와 판의 실제 스크롤바만 예외다. 판 여백·다른 화면 영역은 닫는다.
  useEffect(() => {
    if (!snapAssist) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".canvas-snap-assist-cell")) return;
      if (event.target instanceof HTMLElement && event.target.classList.contains("canvas-snap-assist")
        && event.target.scrollHeight > event.target.clientHeight) {
        const section = event.target;
        const rect = section.getBoundingClientRect();
        const x = (event.clientX - rect.left) * section.offsetWidth / rect.width;
        const border = getComputedStyle(section);
        const left = parseFloat(border.borderLeftWidth);
        const right = section.offsetWidth - parseFloat(border.borderRightWidth);
        // clientLeft에는 왼쪽 스크롤바가, clientWidth에는 어느 쪽 스크롤바도 포함되지 않는다.
        if ((x >= left && x < section.clientLeft)
          || (x >= section.clientLeft + section.clientWidth && x < right)) return;
      }
      setSnapAssist(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [snapAssist]);
  useEffect(() => {
    if (!snapHoldActive) setSnapAssist(false);
  }, [snapHoldActive]);
  // 판은 빈 칸이 있는 동안만 산다 — 마지막 칸을 채우면 걷히고, 뒤에 칸이 다시 비어도(끌어내기·최소화)
  // 새 스냅 없이는 돌아오지 않는다.
  const snapAssistEmptyCount = snapHoldActive ? snapHoldBodies.length - snapHoldTakenExcept(null).size : 0;
  useEffect(() => {
    if (snapAssist && snapAssistEmptyCount === 0) setSnapAssist(false);
  }, [snapAssist, snapAssistEmptyCount]);
  const snapIntoZone = (operationId: string, hit: SnapZoneHit) => {
    snapOperationToArenaRect(operationId, hit.zone, { presetId: hit.set.id, zones: hit.set.zones, zoneIndex: hit.zoneIndex });
    // 빈 칸이 남으면 후보를 권한다 — 전체 한 칸이면 권할 칸이 없다.
    setSnapAssist(hit.set.zones.length > 1);
  };
  const arenaPointOf = (pointer: OperationDragPointer): { x: number; y: number } | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: pointer.clientX - rect.left - arena.x, y: pointer.clientY - rect.top - arena.y };
  };
  const resetSnapDragUi = () => {
    setSnapDragging(false);
    setSnapBar((previous) => (previous.open || previous.hover || previous.full ? { open: false, hover: null, full: false } : previous));
    setSnapGhost(null);
  };
  // 바의 어느 칸 위인가 — 포인터는 캡션이 잡고 있으므로 elementFromPoint 대신 칸 사각형으로 잰다.
  // 사각형은 전환이 끝난 자리(offset 기하)로 잰다: 바는 열리며 14px 내려오고 0.96에서 자라는데,
  // 열리는 도중 getBoundingClientRect로 재면 빠른 드래그가 칸 가장자리에서 빗나간다.
  // 프리셋 안 칸 사이 틈은 가장 가까운 칸으로 친다.
  const settledRectOf = (element: HTMLElement, bar: HTMLDivElement, canvasRect: DOMRect): SnapRect => {
    let left = 0;
    let top = 0;
    for (let node: HTMLElement | null = element; node && node !== bar; node = node.offsetParent as HTMLElement | null) {
      left += node.offsetLeft;
      top += node.offsetTop;
    }
    // 바 자체는 left:anchorX·translate(-50%)라 정착 자리는 anchorX - width/2.
    const barLeft = canvasRect.left + bar.offsetLeft - bar.offsetWidth / 2;
    const barTop = canvasRect.top + bar.offsetTop;
    return { x: barLeft + left, y: barTop + top, width: element.offsetWidth, height: element.offsetHeight };
  };
  const hitTestSnapBar = (pointer: OperationDragPointer): SnapZoneRef | null => {
    const bar = snapBarRef.current;
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    if (!bar || !canvasRect) return null;
    let best: { ref: SnapZoneRef; distance: number } | null = null;
    for (const preset of bar.querySelectorAll<HTMLElement>("[data-snap-preset]:not([data-snap-zone])")) {
      const presetRect = settledRectOf(preset, bar, canvasRect);
      if (pointer.clientX < presetRect.x || pointer.clientX > presetRect.x + presetRect.width || pointer.clientY < presetRect.y || pointer.clientY > presetRect.y + presetRect.height) continue;
      for (const zone of preset.querySelectorAll<HTMLElement>("[data-snap-zone]")) {
        const zoneRect = settledRectOf(zone, bar, canvasRect);
        const centerX = zoneRect.x + zoneRect.width / 2;
        const centerY = zoneRect.y + zoneRect.height / 2;
        const distance = (centerX - pointer.clientX) ** 2 + (centerY - pointer.clientY) ** 2;
        if (best === null || distance < best.distance) best = { ref: { presetIndex: Number(zone.dataset.snapPreset), zoneIndex: Number(zone.dataset.snapZone) }, distance };
      }
    }
    return best?.ref ?? null;
  };
  const pointerOverSnapBar = (pointer: OperationDragPointer): boolean => {
    const bar = snapBarRef.current;
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    if (!bar || !canvasRect) return false;
    const rect = settledRectOf(bar, bar, canvasRect);
    const margin = 8;
    return pointer.clientX >= rect.x - margin && pointer.clientX <= rect.x + rect.width + margin && pointer.clientY >= rect.y - margin && pointer.clientY <= rect.y + rect.height + margin;
  };
  const handleSnapDragPointer = (operationId: string, pointer: OperationDragPointer) => {
    if (!snapEnabled) {
      if (snapDragRef.current) { snapDragRef.current = null; resetSnapDragUi(); }
      return;
    }
    const point = arenaPointOf(pointer);
    if (!point) return;
    const drag = snapDragRef.current?.operationId === operationId
      ? snapDragRef.current
      : { operationId, barOpen: false, zone: null, alignSwapId: null, alignJoin: false };
    if (snapDragRef.current !== drag) { snapDragRef.current = drag; setSnapDragging(true); setSnapAssist(false); }
    // 모두 정렬 중에는 바·핫존이 쉬고 칸 교환·다시 넣기·빼내기만 있다 — 다른 칸에 놓으면 자리를
    // 바꾸고(사이드바 순서도 함께 바뀐다), 칸 밖(자기 칸 포함)에 놓으면 그 패널만 빠진다.
    if (alignMeta && snapHold) {
      drag.barOpen = false;
      drag.zone = null;
      setSnapBar((previous) => (previous.open || previous.hover || previous.full ? { open: false, hover: null, full: false } : previous));
      const drop = alignDropHit(point, operationId);
      drag.alignSwapId = drop.swapId;
      drag.alignJoin = drop.join;
      setSnapGhost(drop.ghost);
      return;
    }
    // 위쪽 띠에 닿으면 손잡이가 바로 자라고, 열린 뒤에는 띠보다 조금 아래까지·바 위까지 붙잡는다(히스테리시스).
    drag.barOpen = snapPointInTopBand(point, snapHitArena, drag.barOpen, arena.width / 2, snapHandleWidth) || (drag.barOpen && pointerOverSnapBar(pointer));
    if (drag.barOpen) {
      // 바를 지나 꼭대기까지 밀면(손잡이 띠·Command Band) Windows의 최대화처럼 아레나 전체 한 칸이다.
      const full = snapPointAtTopEdge(point, snapHitArena, arena.width / 2, snapHandleWidth);
      const hover = full ? null : hitTestSnapBar(pointer);
      drag.zone = hover ? snapZoneHitFor(snapArena, SNAP_PRESETS[hover.presetIndex]!, hover.zoneIndex) : full ? snapZoneHitFor(snapArena, SNAP_FULL_ZONES, 0) : null;
      setSnapBar({ open: true, hover, full });
      setSnapGhost(drag.zone ? arenaRectToBox(frameOf(drag.zone.zone)) : null);
      return;
    }
    setSnapBar((previous) => (previous.open || previous.hover || previous.full ? { open: false, hover: null, full: false } : previous));
    // 가장자리 핫존, 아니면 유지 중인 나누기의 빈 칸. 자기 칸은 비어 있지 않다 — 유지 패널을 끌어 놓는 것은
    // Windows처럼 "풀기"이고, 다시 붙이는 길은 바·핫존·다른 빈 칸이다(칸이 아레나를 다 덮는 나누기에서도 풀 수 있게).
    const edge = snapEdgeHitFor(point, snapHitArena, snapArena)
      ?? (snapHoldActive && snapHoldSet ? snapEmptyZoneHitFor(point, snapArena, snapHoldSet, snapHoldTakenExcept(null)) : null);
    drag.zone = edge;
    setSnapGhost(edge ? arenaRectToBox(frameOf(edge.zone)) : null);
  };
  const handleSnapDragRelease = (operationId: string, pointer: OperationDragPointer) => {
    // 마지막 포인터로 표적을 한 번 더 확정한다 — 해제 직전 이동이 히트테스트를 지나쳤을 수 있다.
    if (snapDragRef.current?.operationId === operationId) handleSnapDragPointer(operationId, pointer);
  };
  // 드래그 해제에서 부모가 커밋 직전에 부른다 — 스냅 표적이 있으면 프레임이 보낸 자유 좌표 대신 그 칸이다.
  const consumeSnapDrag = (operationId: string): boolean => {
    const drag = snapDragRef.current;
    if (!drag || drag.operationId !== operationId) return false;
    snapDragRef.current = null;
    resetSnapDragUi();
    // 모두 정렬 중에는 자리 교환·다시 넣기·빼내기만 있다.
    if (alignMeta && snapHold) {
      if (drag.alignSwapId && drag.alignSwapId !== operationId
        && operationId in snapHold.assignments && drag.alignSwapId in snapHold.assignments) {
        // 그룹을 넘는 드롭은 거부한다 — 순서도 자리도 바꾸지 않고, 패널은 칸으로 되돌아간다.
        if (alignGroupOf(operationId) === alignGroupOf(drag.alignSwapId)) {
          swapAlignSlots(operationId, drag.alignSwapId);
        } else {
          onAlignNotice("canvas.align.crossGroupOnly");
        }
        return true;
      }
      if (drag.alignJoin && !(operationId in snapHold.assignments)) {
        rejoinAlignAllPanel(operationId);
        return true;
      }
      // 칸 밖(자기 칸 포함)에 놓았다 — 그 패널만 빠지고, 놓은 자리가 자유 좌표가 된다.
      if (operationId in snapHold.assignments) detachAlignAllPanel(operationId);
      return false;
    }
    if (!drag.zone || !snapEnabled) {
      // 유지 패널을 칸 밖에 놓았다 — 그 패널만 풀리고, 놓은 자리가 자유 좌표가 된다.
      releaseSnapHoldOperation(operationId);
      return false;
    }
    snapIntoZone(operationId, drag.zone);
    return true;
  };
  // 모두 정렬 드롭 판정 — 유지 칸 프레임으로 잰다. 자기 칸은 표적이 아니다(밖이다).
  const alignDropHit = (point: { readonly x: number; readonly y: number }, operationId: string): { readonly swapId: string | null; readonly join: boolean; readonly ghost: SnapRect | null } => {
    const none = { swapId: null, join: false, ghost: null } as const;
    if (!alignMeta || !snapHold || alignBodies.length === 0) return none;
    const bundled = operationId in snapHold.assignments;
    for (let index = 0; index < alignBodies.length; index += 1) {
      const body = alignBodies[index]!;
      const frame = { x: body.x, y: body.y - OPERATION_WINDOW_CAPTION_HEIGHT, width: body.width, height: body.height + OPERATION_WINDOW_CAPTION_HEIGHT };
      if (!snapPointInRect(point, frame)) continue;
      const ghost = arenaRectToBox(frameOf(body));
      const occupant = Object.entries(snapHold.assignments).find(([, zoneIndex]) => zoneIndex === index)?.[0] ?? null;
      // 자기 칸·빈 칸(있을 수 없다)에 놓는 것은 밖과 같다 — 빼낸다.
      if (occupant === null || occupant === operationId) return none;
      // 묶음 밖 패널이 칸에 닿으면 다시 넣는다 — 자리는 사이드바 순서가 정한다.
      if (!bundled) return { swapId: null, join: true, ghost };
      return { swapId: occupant, join: false, ghost };
    }
    return none;
  };
  // 정렬 순서의 그룹 판정 — 사이드바 평탄화와 같은 소속 기준(op.groupId)이다.
  const alignGroupOf = (operationId: string): string | null =>
    theaterOperations.find((operation) => operation.id === operationId)?.groupId ?? null;
  // 정렬 칸 자리 교환 — 사이드바 순서에서 두 자리를 맞바꾼다. 그룹 소속은 바뀌지 않는다:
  // 순서값 맞교환은 정렬 순위의 전치일 뿐이라 같은 그룹 안에서만 칸이 교환된다.
  // 그룹을 넘는 드롭은 consumeSnapDrag에서 미리 거부한다.
  const swapAlignSlots = (leftId: string, rightId: string): void => {
    const theaterId = state.activeTheaterId;
    if (!theaterId) return;
    const order = operationOrderFromNodes(theaterOperations);
    const leftIndex = order.indexOf(leftId);
    const rightIndex = order.indexOf(rightId);
    if (leftIndex === -1 || rightIndex === -1 || leftIndex === rightIndex) return;
    const next = [...order];
    next[leftIndex] = rightId;
    next[rightIndex] = leftId;
    setOperationOrder(theaterId, next);
  };
  const openSnapMenu = (operationId: string, anchor: DOMRect) => {
    // 정렬 중에는 분할 메뉴를 열지 않는다 — 자리 바꾸기는 캡션 드래그가 소유한다.
    if (alignMeta || !snapEnabled) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSnapMenu({ operationId, anchor: { x: anchor.left - rect.left, y: anchor.top - rect.top, width: anchor.width, height: anchor.height } });
  };
  const closeSnapMenu = useCallback(() => setSnapMenu(null), []);
  const pickSnapMenuZone = (zone: SnapZoneRef) => {
    const menu = snapMenu;
    setSnapMenu(null);
    if (!menu || !snapEnabled) return;
    setActiveOperation(menu.operationId);
    snapIntoZone(menu.operationId, snapZoneHitFor(snapArena, SNAP_PRESETS[zone.presetIndex]!, zone.zoneIndex));
    const geometry = getCanvasSnapshot().operations[menu.operationId];
    if (geometry) void updatePluginOperationGeometry(menu.operationId, geometry);
  };
  const pickSnapAssist = (operationId: string, zoneIndex: number) => {
    if (!snapHoldActive || !snapHoldSet) return;
    setActiveOperation(operationId);
    snapIntoZone(operationId, snapZoneHitFor(snapArena, snapHoldSet, zoneIndex));
    const geometry = getCanvasSnapshot().operations[operationId];
    if (geometry) void updatePluginOperationGeometry(operationId, geometry);
  };
  // 후보 — 이 Theater에서 보이는 자유 패널을 최근 활성 순으로 권한다.
  const snapAssistCandidates: readonly SnapAssistCandidate[] = snapAssist && snapHoldActive && snapHold
    ? theaterOperations
        // 최소화되거나 그릴 수 없는 Operation은 선택해도 보이는 패널을 채울 수 없다.
        .filter((operation) => !minimizedSet.has(operation.id)
          && !(operation.id in snapHold.assignments)
          && operationKindRegistry.some((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type && Boolean(kind.render)))
        .map((operation) => ({ id: operation.id, title: operation.title, z: canvas.operations[operation.id]?.zIndex ?? 0 }))
        .sort((a, b) => b.z - a.z)
        .map(({ id, title }) => ({ id, title }))
    : [];
  // 남은 후보가 없으면 빈 가이드를 남기거나, 나중에 패널이 복귀할 때 판을 다시 열지 않는다.
  useEffect(() => {
    if (snapAssist && snapAssistCandidates.length === 0) setSnapAssist(false);
  }, [snapAssist, snapAssistCandidates.length]);
  const snapAssistZones = snapAssist && snapHoldActive
    ? snapHoldBodies.flatMap((body, index) => (snapHoldTakenExcept(null).has(index) ? [] : [{ index, rect: arenaRectToBox(frameOf(body)) }]))
    : [];
  // 모드·Theater가 바뀌면 스냅 표면을 모두 거둔다.
  useEffect(() => {
    if (snapEnabled) return;
    setSnapMenu(null);
    setSnapAssist(false);
    snapDragRef.current = null;
    resetSnapDragUi();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapEnabled]);
  useEffect(() => {
    setSnapMenu(null);
    setSnapAssist(false);
  }, [state.activeTheaterId]);
  // 퇴장은 한 박자 남긴다 — 판이 줌 한 노치에 즉시 사라지면 패널의 복귀 페이드와 어긋나 화면이 빈다.
  const [fleetMapLeaving, setFleetMapLeaving] = useState(false);
  const previousFleetMapActiveRef = useRef(false);
  useEffect(() => {
    const previous = previousFleetMapActiveRef.current;
    previousFleetMapActiveRef.current = fleetMapActive;
    if (fleetMapActive || !previous || prefersReducedMotion()) {
      setFleetMapLeaving(false);
      return;
    }
    setFleetMapLeaving(true);
    const timer = window.setTimeout(() => setFleetMapLeaving(false), FLEET_MAP_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [fleetMapActive]);
  // 판의 종횡비 — 층은 아레나 안쪽 26px 인셋에 서고 캡션 한 줄(≈28px)을 위에 둔다.
  const fleetMapAspect = Math.max(0.2, (arena.width - 52) / Math.max(1, arena.height - 52 - 28));
  // 판 위의 실행 메뉴 — 실행 좌표는 커서 투영이 아니라 그 Theater가 보고 있던 화면의 중앙이다.
  // 판 위의 커서는 월드와 무관하고, 활성 Theater는 지도 배율(0.02)이라 커서 투영이 수만 단위
  // 밖에 떨어진다. 화면 중앙은 그 Theater를 올렸을 때 보이는 자리라 새 패널이 시야 안에 선다.
  const openFleetMapTheaterLaunchMenu = (theaterId: string, cursor: CanvasPoint) => {
    const theaterViewport = getTheaterCanvasSnapshot(theaterId).viewport;
    setContextMenu({
      anchor: cursor,
      canvasPoint: screenToCanvas({ x: arena.x + arena.width / 2, y: arena.y + arena.height / 2 }, {
        x: theaterViewport.x + arena.x,
        y: theaterViewport.y + arena.y,
        zoom: theaterViewport.zoom,
      }),
      theaterId,
    });
    onRefreshCatalog?.();
  };
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
  // 모두 정렬 순서 — 사이드바 그룹 순서와 같은 원천(flattenGroupedOrder)에서 최소화 패널을 뺀다.
  // 클러스터 단계는 목록에 없어 조율자만 앉는다. 칸 할당은 이 순서의 자리다.
  const alignOrderedIds = flattenGroupedOrder(
    theaterOperations,
    state.groups.filter((group) => group.theaterId === state.activeTheaterId),
    operationOrderFromNodes(theaterOperations),
    [],
  ).filter((operation) => !minimizedSet.has(operation.id)).map((operation) => operation.id);
  // 멤버십·칸 재계산 — 최소화·추가·닫힘·순서 변경·자리 교환·빼내기·나누기 변경이 바뀌면 다시 나눈다.
  // reconcile은 같으면 손대지 않아 effect와 발산하지 않는다.
  const alignOrderKey = alignOrderedIds.join("|");
  useEffect(() => {
    if (!alignMeta) return;
    reconcileAlignAll(alignOrderedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alignMeta, alignOrderKey]);
  const focusCycleIds = focusCycleOperationIds(
    theaterOperations,
    state.groups.filter((group) => group.theaterId === state.activeTheaterId),
    operationOrderFromNodes(theaterOperations),
    canvas.collapsedGroups,
    canvas.minimized,
  );
  const focusCycleIndexByOperationId = new Map(focusCycleIds.map((operationId, index) => [operationId, index + 1]));
  // 캔버스 transform이 제거되는 모드에서 화면에 서는 패널은 net scale 1로 보정한다. 단, focus
  // layer 뒤의 peer는 기존 world geometry와 줌을 그대로 보존한다 — 숨은 xterm까지 fontSize/fit/PTY
  // resize를 fan-out하지 않기 위한 핵심 계약이다.
  const topPanelZIndex = maxOperationZIndex(canvas.operations) + 1;
  const companionSlotCount = visibleCompanionPanels.length + 1;
  // 슬롯 id는 Operation 본체 + 보이는 companion 순서다. 이 배열이 폭의 키이자 분할선의 좌표계다.
  const companionSlotIds = [COMPANION_SESSION_SLOT_ID, ...visibleCompanionPanels.map((panel) => panel.id)];
  const companionSlotWidths = resolveCompanionSlotWidths(
    arena.width,
    companionSlotWeightsFor(companionSlotIds, companionSlotWeights),
  );
  // 분할선은 Cruise companion 배치에만 선다. War Room은 자기 격자가 폭을 정하고,
  // 그 격자를 여기서 갈라 놓으면 모드가 약속한 정렬이 깨진다.
  const companionDividersActive = panelCompanion !== null && !triageActive && companionSlotIds.length > 1;
  companionSlotIdsRef.current = companionSlotIds;
  companionSlotWidthsRef.current = companionSlotWidths;

  /** 분할선 한 칸이 주고받을 수 있는 경계. 이웃한 두 슬롯 밖으로는 폭이 새지 않는다. */
  function companionDividerPair(dividerIndex: number): { readonly leftId: string; readonly rightId: string; readonly leftStart: number; readonly pair: number; readonly floor: number } | null {
    const ids = companionSlotIdsRef.current;
    const widths = companionSlotWidthsRef.current;
    const leftId = ids[dividerIndex];
    const rightId = ids[dividerIndex + 1];
    if (leftId === undefined || rightId === undefined) return null;
    const leftStart = widths[dividerIndex] ?? 0;
    const pair = leftStart + (widths[dividerIndex + 1] ?? 0);
    if (pair <= 0) return null;
    // 쌍이 두 바닥을 담을 수 있으면 바닥은 그대로 320이다. 담지 못할 때만 물러나는데, 그때도
    // "쌍의 절반"까지 내리면 허용 범위가 한 점이 되어 분할선이 아예 안 움직이고 첫 입력이 쌍을
    // 등분으로 튕긴다 — 실측상 1100px 창의 3분할(쌍 475px)에서 조작이 죽었다. 가운데 절반은
    // travel로 남긴다.
    const floor = pair >= COMPANION_MIN_SLOT_PX * 2
      ? COMPANION_MIN_SLOT_PX
      : pair * COMPANION_CRAMPED_SLOT_RATIO;
    return { leftId, rightId, leftStart, pair, floor };
  }

  function applyCompanionDivider(dividerIndex: number, desiredLeft: number, persist: boolean): void {
    const bounds = companionDividerPair(dividerIndex);
    if (bounds === null) return;
    const left = Math.max(bounds.floor, Math.min(bounds.pair - bounds.floor, desiredLeft));
    // 끈 쌍만 적으면 안 된다. 기억된 가중치는 그때 그 아레나의 픽셀 눈금이고 지금 보이는 폭은
    // 이번 아레나의 눈금이라, 둘을 섞어 두면 정규화가 손대지도 않은 패널을 끌고 가고 분할선은
    // 포인터에서 멀어진다. 지금 보이는 폭 전부를 한 눈금으로 다시 적는다 — 확대 표면의
    // 분할선이 페인 배열을 통째로 넘기는 것과 같은 계약이다.
    const ids = companionSlotIdsRef.current;
    const widths = companionSlotWidthsRef.current;
    const next: Record<string, number> = {};
    ids.forEach((slotId, index) => { next[slotId] = widths[index] ?? 0; });
    next[bounds.leftId] = left;
    next[bounds.rightId] = bounds.pair - left;
    setCompanionSlotWeights(next, persist);
  }

  function beginCompanionDividerDrag(dividerIndex: number, event: React.PointerEvent<HTMLDivElement>): void {
    const bounds = companionDividerPair(dividerIndex);
    if (bounds === null) return;
    event.preventDefault();
    const startX = event.clientX;
    const leftStart = bounds.leftStart;
    const target = event.currentTarget;
    // 이 제스처의 주인. 끝 신호를 노드가 아니라 document·window에서 받는 순간 "이 요소에 온
    // 이벤트"라는 울타리가 사라지므로, 울타리를 포인터 자신이 진다 — 아니면 화면에 얹힌 둘째
    // 손가락을 떼는 것만으로 첫 손가락의 드래그가 끝난다(실측 재현).
    const pointerId = event.pointerId;
    target.setPointerCapture(pointerId);
    target.classList.add("is-dragging");
    // 끄는 동안 본문이 글자를 집지 않게 한다 — 터미널 위를 지나는 제스처가 선택으로 새면
    // 손을 떼는 순간 화면의 절반이 파랗게 남는다.
    document.body.setAttribute("data-companion-resizing", "true");

    // 제스처를 거두는 길은 하나여야 한다.
    //
    // 끌던 중 분할선이 사라지면(Alt+T로 모드가 바뀌거나 마지막 companion이 닫히면) 떼어진 노드에는
    // 끝 이벤트가 오지 않아 전역 플래그가 남고, 앱 전체가 선택 불가·col-resize 커서로 굳는다 —
    // 실측으로 재현했다. 그때 브라우저가 실제로 보내는 것은 **document의 lostpointercapture**이고
    // (요소가 아니다), 이어지는 pointerup은 커서 아래의 다른 요소에서 window까지 버블한다.
    // 그래서 끝 신호는 노드가 아니라 document·window에서 받는다.
    let settled = false;
    const finish = (clientX: number | null) => {
      if (settled) return;
      settled = true;
      if (clientX !== null) applyCompanionDivider(dividerIndex, leftStart + (clientX - startX), true);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      target.classList.remove("is-dragging");
      document.body.removeAttribute("data-companion-resizing");
      target.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.removeEventListener("lostpointercapture", onLost);
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      applyCompanionDivider(dividerIndex, leftStart + (moveEvent.clientX - startX), false);
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      finish(upEvent.clientX);
    };
    // 캡처를 잃은 자리는 포인터가 어디 있었는지 말해 주지 않는다 — 마지막으로 놓인 폭을 그대로 둔다.
    // 정상 종료에서는 pointerup이 먼저 와 이미 settled이므로 이 경로는 조용히 지나간다.
    const onLost = (lostEvent: PointerEvent) => {
      if (lostEvent.pointerId !== pointerId) return;
      finish(null);
    };

    // 이동만 노드에서 받는다 — 노드가 떨어져 나가면 이동도 그 자리에서 멎어야 한다.
    target.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.addEventListener("lostpointercapture", onLost);
  }

  function nudgeCompanionDivider(dividerIndex: number, deltaPx: number): void {
    const bounds = companionDividerPair(dividerIndex);
    if (bounds === null) return;
    applyCompanionDivider(dividerIndex, bounds.leftStart + deltaPx, true);
  }

  /** 기억을 지우는 것이 곧 등분으로 되돌리는 것이다. */
  function resetCompanionDividers(): void {
    resetCompanionSlotWeights(companionSlotIdsRef.current);
  }
  // 전환 제목의 낭독 문장 — 시각 요소와 같은 문자열을 상시 status 영역에 싣는다.
  const modeTitleAnnouncement = alignEntering
    ? `${t("canvas.align.modeTitle")} — ${t("canvas.align.modeBody", { count: alignOrderedIds.length })}`
    : triageEntering
      ? `${t("canvas.triage.modeTitle")} — ${triageQueue.length > 0
        ? t("canvas.triage.modeBody", { waiting: triageQueue.length, stowed: Math.max(0, triageDeckOperations.length - 1) })
        : t("canvas.triage.modeBodyEmpty", { stowed: triageDeckOperations.length })}`
      : cruiseEntering
        ? cruiseReturnFromAlignRef.current
          ? `${t("canvas.align.offTitle")} — ${t("canvas.align.offBody", { count: alignOrderedIds.length })}`
          : `${t("canvas.cruise.modeTitle")} — ${alignOrderedIds.length > 0
            ? t("canvas.cruise.modeBody", { count: alignOrderedIds.length })
            : t("canvas.cruise.modeBodyEmpty")}`
        : "";

  return (
    <main
      className={`operations-canvas ${interaction.spaceActive ? "is-panning" : ""} ${interaction.shiftActive ? "is-creating" : ""} ${glanceVisible ? "is-glance" : ""} ${panelMaximized ? "is-panel-maximized" : ""} ${panelCompanion ? "is-companion-layout" : ""} ${triageActive ? "is-triage" : ""} ${triageEntering ? "is-triage-entering" : ""} ${fleetMapActive ? "is-fleet-map" : ""} ${focusFadeTransitionReady ? "" : "is-focus-fade-settling"}`}
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
      style={{
        // 아레나 인셋을 CSS 채널로 노출한다 — 모드 프레임·덱·빈 상태·미니맵이 부유 크롬을
        // 피해 앉는 단일 원천이다(감사 계약: 주입구 하나).
        "--arena-left": `${arenaInsets.left}px`,
        "--arena-right": `${arenaInsets.right}px`,
        "--arena-top": `${arenaInsets.top}px`,
        "--arena-bottom": `${arenaInsets.bottom}px`,
      } as CSSProperties}
    >
      <CanvasGrid viewport={screenViewport} />
      <div
        style={{
          // 최대화 시 transform 제거(none)로 net scale 1. 일반 상태에서는 pan 좌표를 정수 픽셀로 스냅해
          // will-change 합성 레이어의 서브픽셀 오프셋 리샘플(글자 번짐)을 제거한다.
          // 월드는 아레나 원점에 앵커된다 — 저장 좌표를 옮기지 않고 전면 캔버스를 세우는 계약.
          transform: panelMaximized || panelCompanion || triageActive
            ? "none"
            : `translate(${Math.round(screenViewport.x)}px, ${Math.round(screenViewport.y)}px) scale(${screenViewport.zoom})`,
        }}
        className="operations-canvas-world"
      >
        {pluginOperations.map((operation) => {
          const clusterRoot = clusterIndex.rootOf.get(operation.id) ?? null;
          const baseGeometry = canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation);
          const operationMaximized = panelMaximized === operation.id;
          const operationCompanion = panelCompanion === operation.id;
          const operationTriageStage = triageStageId === operation.id;
          // 덱 칸이 잡혀 있으면 그 자리가 이 패널의 자리다 — 캔버스 좌표 대신 칸 안으로 들어가
          // 칸 크기를 그대로 입는다(PTY도 그 크기로 맞춰진다).
          // companion을 연 패널은 칸에 담기지 않는다 — 그 레이아웃은 캔버스를 나눠 쓰는 모드이고,
          // 렌더는 프레임과 companion 프레임을 한 벌로 내놓는다. 칸으로 들여보내면 캔버스 좌표를
          // 지닌 companion들이 타일 안으로 함께 딸려 들어간다. 덱 칸은 그때 이름만 남기고 비운다.
          const snapAssistSlot = snapAssist && snapHoldActive && snapHold && !(operation.id in snapHold.assignments) ? snapAssistSlots.get(operation.id) ?? null : null;
          const deckSlot = operationTriageStage || operationCompanion ? null : triageDeckSlots.get(operation.id) ?? snapAssistSlot;
          const operationGroup = resolveOperationGroup(operation, groupById);
          // 색을 못 푸는 그룹은 라벨 자체를 내지 않는다 — 도트 없는 이름만 남으면 그것이 그룹이라는
          // 사실을 캡션에서 읽을 수 없다.
          const operationGroupColor = operationGroup ? resolveAccentColor(operationGroup.color) : null;
          // focus layer는 peer를 실제 최소화하지 않고, mount를 보존한 채 렌더만 감춘다.
          // 선별 중 무대 밖 패널은 감추는 대상이 아니다 — 덱 칸에 자기 자리를 갖고 거기 서 있다.
          const focusLayerHidden = triageActive
            ? !operationTriageStage && !deckSlot
            : (panelMaximized !== null || panelCompanion !== null) && !operationMaximized && !operationCompanion;
          // 유지 패널은 칸에서 편 좌표로 선다 — 끌고 있는 동안만 손을 따른다. 모두 정렬도 같은 칸이다.
          const snapHeldIndex = snapHoldActive && snapHold ? snapHold.assignments[operation.id] : undefined;
          const snapHeldRect = snapHeldIndex !== undefined && !(snapDragging && snapDragRef.current?.operationId === operation.id)
            ? snapHoldWorldRect(snapHeldIndex)
            : null;
          const operationZoom = focusLayerHidden
            ? canvas.viewport.zoom
            : triageActive || operationMaximized || operationCompanion
              ? 1
              : canvas.viewport.zoom;
          const glanceHud = resolveGlanceHudModel(triageActive
            ? {
                mode: "triage",
                index: Math.max(1, triageDisplayQueue.findIndex((entry) => entry.operation.id === operation.id) + 1),
                total: triageDisplayQueue.length,
                companionOpen: panelCompanion !== null,
                setAsideArmed: operationTriageStage && setAsideArmedId === operation.id,
              }
            : {
                mode: "map",
                index: focusCycleIndexByOperationId.get(operation.id) ?? 1,
                maximized: operationMaximized,
                companionOpen: panelCompanion !== null,
              });
          const frameGeometry = operationTriageStage
            ? triageStageGeometryFor(modeArena, topPanelZIndex, 0, triageActive && operationCompanion ? companionSlotCount : 1)
            : operationMaximized
            ? maximizedGeometryFor(arena, topPanelZIndex)
            : operationCompanion
            ? companionGeometryFor(arena, 0, companionSlotWidths, topPanelZIndex)
            : snapHeldRect ? { ...baseGeometry, ...snapHeldRect } : baseGeometry;
          // 보더 위 캡션(top: -32px)이 캔버스 상단 클립에 잘리는 뷰포트-상대 위치.
          // War Room/최대화는 슬롯을 32px 내려 캡션을 밖에 둔다. 본문·PTY geometry는 그대로다.
          const topEdge = !operationTriageStage && !operationMaximized && !operationCompanion && !deckSlot
            && screenViewport.y + frameGeometry.y * operationZoom < TITLEBAR_OUTSET_PX * operationZoom;
          // 지휘관 패널은 고른 구성원의 본문을 보인다 — 프레임은 지휘관, 본문 마운트만 풀에서 옮겨 온다.
          // 고를 수 있는 것은 이 패널이 대표하는 구성원뿐이다(코어의 부모 관계). 묶음 선언이 아직 오지 않은 Theater 에서도 같다.
          // War Room 덱 칸에는 노드 줄이 없어 누구 본문인지 말할 수 없으므로 지휘관 자신의 본문을 둔다.
          const chosenBody = clusterBodySelection[operation.id];
          const bodyNode = chosenBody && !deckSlot
            ? state.nestedOperations.find((candidate) => candidate.id === chosenBody && candidate.parentOperationId === operation.id) ?? null
            : null;
          const bodyMember = bodyNode ? clusterRoot?.formation.byOperationId.get(bodyNode.id)?.member ?? null : null;
          return renderPluginOperation(operation, {
            capabilities,
            active: activePluginOperationId === operation.id,
            unseen: idleArrivalIds.has(operation.id),
            keyboardFocusRequestId: state.keyboardFocusRequest?.operationId === operation.id
              ? state.keyboardFocusRequest.requestId
              : 0,
            geometry: frameGeometry,
            topEdge,
            snapHeld: snapHeldIndex !== undefined,
            alignHeld: alignMeta !== null && snapHeldIndex !== undefined,
            operationKindRegistry,
            // 캡션 비콘은 사이드바 칩과 같은 원천을 읽어야 한다 — 런타임 맵을 날로 조회하면 아직
            // 런타임 축을 심지 않은 복원 Operation이 doctrine상 dormant인데도 캡션에서만 idle로 서서,
            // 같은 순간 사이드바는 휴면, 패널은 초록이라고 말한다.
            status: resolveOperationActivity(operation, operationRuntime),
            bodyOperation: bodyNode ? { operation: bodyNode, runtimeState: pluginRuntimeState(operationRuntime, state.operationRuntimeHydration, bodyNode.id) } : null,
            // 본문의 주인이 캡션 선반의 주인이다 — 제목 뒤 「› 이름」이 그 사실을 말한다. 이름·톤은 묶음이 준 것을 먼저 쓴다.
            subject: bodyNode ? {
              name: bodyMember?.name ?? nestedSubjectName(operation, bodyNode),
              title: bodyNode.title,
              tone: bodyMember?.tone ?? canvas.operationAccent[bodyNode.id] ?? operationAccentFromNode(bodyNode),
            } : null,
            cluster: clusterRoot
              ? {
                strip: (
                  <ClusterStrip
                    layout={clusterRoot}
                    rootActivity={resolveOperationActivity(operation, operationRuntime)}
                    onOpen={(operationId, event) => {
                      const target = event?.currentTarget as HTMLElement | undefined;
                      const panel = target?.closest<HTMLElement>("[data-operation-id]") ?? null;
                      const anchor = target?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0);
                      const panelRect = panel?.getBoundingClientRect();
                      const canvasRect = canvasRef.current?.getBoundingClientRect();
                      const canvasTop = (canvasRect?.top ?? 0) + (arenaInsets?.top ?? 0);
                      setClusterPicker({
                        rootId: operation.id,
                        targetOperationId: operationId,
                        anchor,
                        canvasTop,
                        panelRect: panelRect ? { left: panelRect.left, top: panelRect.top, width: panelRect.width, height: panelRect.height, bottom: panelRect.bottom } : undefined,
                      });
                    }}
                  />
                ),
                nodes: (
                  <ClusterNodeRail
                    layout={clusterRoot}
                    current={clusterRoot.formation.byOperationId.has(clusterBodySelection[operation.id] ?? "") ? clusterBodySelection[operation.id]! : operation.id}
                    rootActivity={resolveOperationActivity(operation, ownOperationRuntime())}
                    onPick={(operationId) => {
                      selectNestedBody(operation.id, operationId);
                      setActiveOperation(operation.id);
                      requestOperationKeyboardFocus(operation.id);
                    }}
                  />
                ),
              }
              : null,
            runtimeState: pluginRuntimeState(operationRuntime, state.operationRuntimeHydration, operation.id),
            theme: state.activeTheme,
            language,
            viewportZoom: operationZoom,
            // 선별 중 무대 밖 패널은 덱 칸으로 간다 — 자리가 있으면 그 자리에 실물로 서므로
            // 숨기지 않고, 자리가 아직 없을 때만(입장 연출·지도 전환 직전) 접어 둔다.
            // 후보 판의 칸에 선 동안은 최소화 상태여도 실물로 선다(War Room 덱과 같다).
            minimized: triageActive ? !operationTriageStage && !deckSlot : minimizedSet.has(operation.id) && !snapAssistSlot,
            maximized: operationMaximized,
            triageStage: operationTriageStage,
            triagePicked: operationTriageStage && triageStage?.picked === true,
            glanceHud,
            companion: operationCompanion,
            companions: operationCompanion ? visibleCompanionPanels : [],
            companionGeometries: operationCompanion
              ? visibleCompanionPanels.map((panel, index) => {
                  const slot = triageActive
                    ? triageStageGeometryFor(modeArena, topPanelZIndex, index + 1, companionSlotCount)
                    : companionGeometryFor(arena, index + 1, companionSlotWidths, topPanelZIndex);
                  // 세 배치 모두 캡션 높이만큼 아래에서 시작한다(캡션이 그 위 띠를 채운다는 전제).
                  // 캡션 없는 companion은 그 띠가 빈 채 남으므로 본문에 돌려준다 — 프레임 꼭대기가
                  // 이웃 Operation의 캡션 꼭대기와 나란히 선다.
                  return panel.hideCaption ? reclaimCaptionOutset(slot) : slot;
                })
              : [],
            hiddenCompanionPanelIds: operationCompanion ? hiddenCompanionPanelIds : [],
            projected: triageActive,
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
            theaterLabel: null,
            onActivate: () => {
              setActiveOperation(operation.id);
              // 선별 중에는 기록하지 않는다 — 무대는 슬롯 geometry이고, 외부 Theater 무대의 기록은
              // 활성 Theater 캔버스 store를 오염시킨다.
              if (!operationMaximized && !operationCompanion && !triageActive) setOperationGeometry(operation.id, canvas.operations[operation.id] ?? operation.geometry ?? ensurePluginGeometry(operation));
              if (!triageActive) notifyMapOperationSelected(operation.id);
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
              playMinimizeFlight(operation.id);
              if (triageActive) {
                // War Room의 최소화는 deck에서 내리는 동작이다. 무대에 서 있던 패널이면 지목까지
                // 거둬 무대를 함께 비운다 — 지목이 남으면 큐가 비어도 그 패널이 무대에 붙어 있다.
                forgetTriageOperation(operation.id);
                setTheaterOperationMinimized(operation.theaterId, operation.id, true);
                return;
              }
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
            onOpenMenu: (anchor, returnFocus, align) => {
              onOpenOperationMenu?.(operation.id, anchor, returnFocus, align);
            },
            menuOpen: openMenuOperationId === operation.id,
            onRenderHiddenDismissMenu: () => {
              onDismissOperationMenu?.(operation.id);
            },
            onGeometryChange: (geometry) => {
              if (operationMaximized || operationCompanion || triageActive) return;
              // 유지 패널의 크기 조절 — 칸 분수로 되돌리고, 같은 선을 나누던 이웃 칸도 따라간다. 이동(크기 같음)은
              // 드래그라 자유 좌표로 흐르고, 놓는 곳이 칸이면 커밋에서 다시 칸이 된다.
              // 모두 정렬 중 크기 조절은 자동 채움이 소유한다 — 칸 분수를 손대지 않고 무시한다.
              if (snapHeldIndex !== undefined && snapHeldRect && snapHold && (Math.abs(geometry.width - snapHeldRect.width) > 0.5 || Math.abs(geometry.height - snapHeldRect.height) > 0.5)) {
                if (snapHold.alignAll) return;
                const zoom = canvas.viewport.zoom;
                const frame = {
                  x: geometry.x * zoom + canvas.viewport.x,
                  y: geometry.y * zoom + canvas.viewport.y - OPERATION_WINDOW_CAPTION_HEIGHT,
                  width: geometry.width * zoom,
                  height: geometry.height * zoom + OPERATION_WINDOW_CAPTION_HEIGHT,
                };
                setSnapHoldZones(snapZonesResized(snapArena, snapHold.zones, snapHeldIndex, frame, MIN_OPERATION_WIDTH, MIN_OPERATION_HEIGHT));
                return;
              }
              setOperationGeometry(operation.id, geometry);
            },
            onGeometryCommit: (geometry) => {
              if (operationMaximized || operationCompanion) return;
              // 정렬 중에는 서버 기하를 절대 건드리지 않는다 — 칸 좌표는 localStorage 유지에만 쓰고,
              // 서버의 Cruise 진실은 켜기 전 자리 그대로 둔다(저장 무결성).
              const persistGeometry = alignMeta === null;
              // 스냅 표적이 있으면 그 칸이 자리다 — 사용자가 고른 칸이라 Station Keeping 정착을 건너뛴다.
              if (consumeSnapDrag(operation.id)) {
                if (persistGeometry) void updatePluginOperationGeometry(operation.id, getCanvasSnapshot().operations[operation.id] ?? geometry);
                return;
              }
              // 유지 패널의 크기 조절 커밋 — 칸은 이미 바뀌었고 좌표는 칸에서 되쓴 값이 맞다.
              if (getCanvasSnapshot().snapHold?.assignments[operation.id] !== undefined) {
                if (persistGeometry) void updatePluginOperationGeometry(operation.id, getCanvasSnapshot().operations[operation.id] ?? geometry);
                return;
              }
              // Station Keeping: 해제 시점에 만진 패널만 정착시킨 뒤, 정착된 스냅샷을 durable로 보낸다.
              if (!triageActive) settleOperationGeometry(operation.id);
              if (persistGeometry) void updatePluginOperationGeometry(operation.id, getCanvasSnapshot().operations[operation.id] ?? geometry);
            },
            onDragPointer: (pointer) => handleSnapDragPointer(operation.id, pointer),
            onDragRelease: (pointer) => handleSnapDragRelease(operation.id, pointer),
            // 정렬 중에는 분할 메뉴를 열지 않는다 — 자리 바꾸기는 캡션 드래그가 소유한다.
            onOpenSnapMenu: alignMeta ? undefined : (anchor) => openSnapMenu(operation.id, anchor),
          });
        })}
        {companionDividersActive ? companionSlotIds.slice(0, -1).map((slotId, index) => (
          <CompanionDivider
            key={`companion-divider-${slotId}`}
            geometry={companionDividerGeometryFor(arena, index, companionSlotWidths, topPanelZIndex + 1)}
            label={t("canvas.companion.dividerAria")}
            onPointerDown={(event) => beginCompanionDividerDrag(index, event)}
            onNudge={(delta) => nudgeCompanionDivider(index, delta)}
            onReset={resetCompanionDividers}
          />
        )) : null}
      </div>
      {fleetMapActive || fleetMapLeaving ? (
        <FleetMap
          theaters={state.theaters}
          operations={fleetMapOperations}
          operationRuntime={operationRuntime}
          activeTheaterId={state.activeTheaterId}
          aspect={fleetMapAspect}
          leaving={!fleetMapActive}
          // 마커의 자리는 라이브 캔버스 배치가 정본이다 — 로드되지 않은 Theater는 저장 스냅샷으로 읽는다.
          geometryFor={(operation) => operation.theaterId === state.activeTheaterId
            ? canvas.operations[operation.id] ?? operation.geometry ?? null
            : getTheaterCanvasSnapshot(operation.theaterId).operations[operation.id] ?? operation.geometry ?? null}
          // 점을 고르면 그 Operation으로 내려간다 — 페이지의 포커스 경로가 Theater 전환과 줌 복귀를
          // 함께 지고, 포커스 줌 하한(0.25)이 지도 이탈 임계 위라 판은 그 자리에서 걷힌다.
          onPick={(operationId) => {
            onFocus(operationId);
            notifyMapOperationSelected(operationId);
          }}
          // 표석을 고르면 그 Theater가 올라온다 — 그 Theater의 저장 viewport가 판독 배율이면 판은
          // 그 자리에서 걷히고, 아직 지도 배율이면 활성 구역만 옮겨 앉는다.
          onSelectTheater={(theaterId) => {
            if (theaterId === state.activeTheaterId) return;
            // 판이 보여 준 패널이 그대로 올라와야 "마운트"다 — 그 Theater를 이 세션에서 처음 여는
            // 것이라면 부팅 최소화가 전 패널을 접어 빈 캔버스로 맞이하므로, 그 한 번을 여기서 소비한다.
            claimTheaterBootMinimization(theaterId);
            // Theater를 바꾸는 표석 선택은 이전 Theater의 Operation 선택을 함께 걷는다 — 숨은
            // 패널이 active로 남으면 그 패널의 companion 단축키가 계속 노출·실행된다.
            clearActiveOperation();
            setActiveTheater(theaterId);
          }}
          onOperationContextMenu={onOpenOperationMenu}
          onTheaterContextMenu={openFleetMapTheaterLaunchMenu}
        />
      ) : null}
      {alignEntering && !triageActive ? (
        <ModeTitle
          kicker={t("canvas.align.modeKicker")}
          title={t("canvas.align.modeTitle")}
          body={t("canvas.align.modeBody", { count: alignOrderedIds.length })}
        />
      ) : null}
      {snapHoldActive ? (
        // 유지의 표시 — "이 화면은 정돈된 상태"라는 한 문법. 모두 정렬도 같은 브래킷을 쓴다.
        <div className="canvas-mode-frame is-snap-hold" aria-hidden="true">
          <span className="canvas-mode-bracket canvas-mode-bracket--nw" />
          <span className="canvas-mode-bracket canvas-mode-bracket--ne" />
          <span className="canvas-mode-bracket canvas-mode-bracket--sw" />
          <span className="canvas-mode-bracket canvas-mode-bracket--se" />
        </div>
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
          {triageEntering ? (
            <ModeTitle
              kicker={t("canvas.triage.modeKicker")}
              title={t("canvas.triage.modeTitle")}
              body={triageQueue.length > 0
                ? t("canvas.triage.modeBody", { waiting: triageQueue.length, stowed: Math.max(0, triageDeckOperations.length - 1) })
                : t("canvas.triage.modeBodyEmpty", { stowed: triageDeckOperations.length })}
            />
          ) : null}
        </>
      ) : null}
      <TriageWatchDeck
        active={triageActive}
        theaters={state.theaters}
        operations={triageDeckOperations}
        operationRuntime={operationRuntime}
        operationAccent={canvas.operationAccent}
        arrivingOperationId={triageDeckArrivingOperationId}
        stagedOperationId={triageStageId}
        onBeforePick={triageDeckZoom.control.snapZoomTween}
        onPanelSlotRef={registerTriageDeckSlot}
        freshOperationIds={freshDeckOperationIds}
        onOperationContextMenu={onOpenOperationMenu}
        onTheaterContextMenu={openTriageTheaterLaunchMenu}
      />
      {clusterPicker ? (() => {
        const layout = clusterIndex.rootOf.get(clusterPicker.rootId);
        if (!layout) return null;
        const rootNode = state.operations?.find((candidate) => candidate.id === clusterPicker.rootId) ?? null;
        return (
          <ClusterPicker
            layout={layout}
            anchor={clusterPicker.anchor}
            panelRect={clusterPicker.panelRect}
            canvasTop={clusterPicker.canvasTop}
            targetOperationId={clusterPicker.targetOperationId}
            current={clusterBodySelection[clusterPicker.rootId] ?? null}
            rootActivity={rootNode ? resolveOperationActivity(rootNode, operationRuntime) : null}
            onPick={(operationId) => {
              // 단계는 어느 모드에서도 패널로 서지 않는다 — 지휘관 패널의 본문을 그 단계로 바꾼다(노드 줄과 같은 동작).
              selectNestedBody(clusterPicker.rootId, operationId);
              setActiveOperation(clusterPicker.rootId);
              requestOperationKeyboardFocus(clusterPicker.rootId);
            }}
            onOpenItem={layout.cluster.open ? (operationId) => layout.cluster.open?.(operationId) : undefined}
            onClose={() => setClusterPicker(null)}
          />
        );
      })() : null}
      {cruiseEntering ? (
        <ModeTitle
          kicker={t(cruiseReturnFromAlignRef.current ? "canvas.align.modeKicker" : "canvas.cruise.modeKicker")}
          title={t(cruiseReturnFromAlignRef.current ? "canvas.align.offTitle" : "canvas.cruise.modeTitle")}
          body={cruiseReturnFromAlignRef.current
            ? t("canvas.align.offBody", { count: alignOrderedIds.length })
            : alignOrderedIds.length > 0
              ? t("canvas.cruise.modeBody", { count: alignOrderedIds.length })
              : t("canvas.cruise.modeBodyEmpty")}
        />
      ) : null}
      {/* 전환 제목의 낭독 채널 — 상시 마운트된 status 영역이라 첫 전환부터 알린다. */}
      <div className="canvas-mode-title-status" role="status" aria-live="polite">{modeTitleAnnouncement}</div>
      <TriageClearPlate active={triageActive && triageDeckOperations.length === 0} entering={triageEntering} hasContent={hasContent} idleCount={triageIdleCount} />
      {/* 함대 지도가 서면 활성 Theater의 빈 상태는 동시 표면이 아니다 — 다른 Theater의 패널로
          지도가 서는 동안 빈 상태를 함께 두면 지도를 가리고 숨은 버튼이 탭 순서에 남는다. 퇴장
          단계는 지도가 입력을 이미 놓은 cross-fade라 새 표면이 바로 서도 된다. */}
      {!triageActive && !fleetMapActive && !hasContent && !alignEntering && !cruiseEntering ? (
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
      {interaction.rubberBand ? <RubberBand rect={interaction.rubberBand} viewport={screenViewport} /> : null}
      {snapEnabled ? <>
        <SnapGhost rect={snapGhost} />
        {/* 손잡이는 Command Band 아랫변(아레나 윗변)에 물려 내려오고, 아레나 폭의 절반쯤(360~760px)을 차지한다. 정렬 중에는 바가 열리지 않아 손잡이도 쉰다. */}
        <SnapHandle visible={snapDragging && !snapBar.open && !alignMeta} anchorX={arena.x + arena.width / 2} anchorY={arena.y} width={snapHandleWidth} />
        <SnapLayoutBar ref={snapBarRef} open={snapBar.open} hover={snapBar.hover} full={snapBar.full} anchorX={arena.x + arena.width / 2} anchorY={arena.y + SNAP_TOP_FULL_EDGE} />
        {snapAssistZones.length > 0 && snapAssistCandidates.length > 0 ? <SnapAssist zones={snapAssistZones} candidates={snapAssistCandidates} onPanelSlotRef={registerSnapAssistSlot} onPick={pickSnapAssist} onClose={closeSnapAssist} /> : null}
        {snapMenu ? (
          <SnapLayoutMenu
            title={state.operations.find((operation) => operation.id === snapMenu.operationId)?.title ?? ""}
            anchor={snapMenu.anchor}
            boundsWidth={canvasSize.width}
            boundsHeight={canvasSize.height}
            onPick={pickSnapMenuZone}
            onClose={closeSnapMenu}
          />
        ) : null}
      </> : null}
      {contextMenu ? createPortal(
        <CanvasContextMenu
          key={`${contextMenu.anchor.x}:${contextMenu.anchor.y}`}
          anchor={contextMenu.anchor}
          viewportBounds={{ width: window.innerWidth, height: window.innerHeight }}
          placement="cursor"
          catalog={catalog}
          // 실행 가부는 모드가 아니라 Theater가 정한다 — 사이드바와 좌하단 런처는 어느 모드에서도
          // 같은 catalog를 그대로 실행하므로, 여기만 War Room을 이유로 막으면 같은 메뉴가
          // 진입 경로에 따라 죽는다. War Room이 막는 것은 캔버스 제스처(팬·줌·드래그 생성)뿐이다.
          canLaunch={canLaunch}
          renderKindIcon={renderKindIcon}
          onLaunchKind={handleContextMenuLaunchKind}
          onClose={() => setContextMenu(null)}
        />,
        document.body,
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
        // 렌즈와 점프의 기준 창은 아레나다 — 캔버스 박스로 재면 크롬에 덮인 영역을
        // "보이는 창"으로 치고, 점프가 대상을 부유 카드 밑 중앙에 앉힌다.
        canvasSize={{ width: arena.width, height: arena.height }}
        onJump={(center) => setViewport({
          x: arena.width / 2 - center.x * canvas.viewport.zoom,
          y: arena.height / 2 - center.y * canvas.viewport.zoom,
          zoom: canvas.viewport.zoom,
        })}
      />
    </main>
  );
}

function rectToGeometry(rect: CanvasRect): OperationGeometry {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, zIndex: 0 };
}

function ensurePluginGeometry(operation: OperationNode): OperationGeometry {
  return operation.geometry ?? { x: 0, y: 0, width: DEFAULT_SHELL_WIDTH, height: DEFAULT_SHELL_HEIGHT, zIndex: 0 };
}

// 최대화 패널은 world transform이 none인 상태에서 렌더되므로 화면 좌표 기준 아레나 풀사이즈로 배치한다.
// viewport에 의존하지 않아 현재 줌/팬과 무관하게 항상 net scale 1로 최대화된다. 기준은 캔버스
// 박스가 아니라 아레나 — 전면 캔버스에서 박스 가장자리 채움은 부유 크롬 밑 채움이 된다.
function maximizedGeometryFor(arena: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, zIndex: number): OperationGeometry {
  return {
    x: arena.x,
    y: arena.y + TITLEBAR_OUTSET_PX,
    width: Math.max(320, arena.width),
    height: Math.max(240, arena.height - TITLEBAR_OUTSET_PX),
    zIndex,
  };
}

// Companion layout은 world transform이 none인 전용 화면 레이아웃이다. Map의 geometry/viewport를
// 변경하지 않으므로 EXIT 시 원상 복원된다.
//
// 폭은 더 이상 등분이 아니다 — 슬롯마다 사용자가 나눈 몫을 갖고, 그 몫은 companion-widths가 푼다.
// 여기서는 이미 풀린 폭 배열을 받아 x만 누적한다.
function companionGeometryFor(
  arena: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  slotIndex: number,
  slotWidths: readonly number[],
  zIndex: number,
): OperationGeometry {
  let x = arena.x;
  for (let index = 0; index < slotIndex; index += 1) x += (slotWidths[index] ?? 0) + COMPANION_SLOT_GAP_PX;
  return {
    x,
    y: arena.y + TITLEBAR_OUTSET_PX,
    width: Math.max(0, slotWidths[slotIndex] ?? 0),
    height: Math.max(0, arena.height - TITLEBAR_OUTSET_PX),
    zIndex,
  };
}

/**
 * 두 슬롯 사이 틈의 좌표 — 분할선이 서는 자리.
 *
 * 세로 범위는 Operation 본체의 띠를 쓴다. 캡션 없는 companion은 그 위 32px을 본문으로 되찾지만,
 * 분할선까지 따라 올라가면 이웃 Operation의 캡션과 같은 줄에서 캡션 버튼을 가로막는다.
 */
function companionDividerGeometryFor(
  arena: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  dividerIndex: number,
  slotWidths: readonly number[],
  zIndex: number,
): OperationGeometry {
  let x = arena.x;
  for (let index = 0; index <= dividerIndex; index += 1) x += (slotWidths[index] ?? 0) + (index === dividerIndex ? 0 : COMPANION_SLOT_GAP_PX);
  return {
    x,
    y: arena.y + TITLEBAR_OUTSET_PX,
    width: COMPANION_SLOT_GAP_PX,
    height: Math.max(0, arena.height - TITLEBAR_OUTSET_PX),
    zIndex,
  };
}

/**
 * Companion 배치의 분할선.
 *
 * 슬롯이 아니라 캔버스가 그린다 — 이 선은 두 슬롯 사이의 경계이지 어느 한쪽의 부속이 아니다.
 * 조작 문법은 확대 표면의 분할선과 같다: 끌기, ←/→ 한 걸음, 그리고 더블클릭으로 등분 복귀.
 */
function CompanionDivider({ geometry, label, onPointerDown, onNudge, onReset }: {
  readonly geometry: OperationGeometry;
  readonly label: string;
  readonly onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onNudge: (deltaPx: number) => void;
  readonly onReset: () => void;
}) {
  return (
    <div
      className="canvas-companion-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      data-canvas-blocker
      style={{
        left: Math.round(geometry.x),
        top: Math.round(geometry.y),
        width: Math.round(geometry.width),
        height: Math.round(geometry.height),
        zIndex: geometry.zIndex,
      } satisfies CSSProperties}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onNudge(-COMPANION_KEYBOARD_STEP_PX);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onNudge(COMPANION_KEYBOARD_STEP_PX);
        }
      }}
    >
      <span className="canvas-companion-divider-grip" aria-hidden="true" />
    </div>
  );
}

/* 캡션 없는(hideCaption) companion — 슬롯이 비워 둔 캡션 띠를 본문 높이로 되돌린다. */
function reclaimCaptionOutset(geometry: OperationGeometry): OperationGeometry {
  return { ...geometry, y: geometry.y - TITLEBAR_OUTSET_PX, height: geometry.height + TITLEBAR_OUTSET_PX };
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

function resolveDefaultLaunchTarget(catalog: readonly OperationCatalogPlugin[]): { readonly pluginId: string | null; readonly kind: OperationLaunchKind } | null {
  const availableKinds = catalog.flatMap((plugin) =>
    plugin.kinds.filter((kind) => kind.disabled !== true).map((kind) => ({ pluginId: plugin.id, kind })),
  );
  return availableKinds[0] ?? null;
}

// 패널 헤더 이름 변경은 캔버스 내부에서 즉시 처리한다.
function operationAccentFromNode(operation: OperationNode): string | null {
  return typeof operation.accent === "string" ? operation.accent : null;
}

function renderPluginOperation(operation: OperationNode, options: {
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly active: boolean;
  readonly unseen: boolean;
  readonly keyboardFocusRequestId: number;
  readonly geometry: OperationGeometry;
  readonly operationKindRegistry: readonly OperationKindDescriptor[];
  readonly status?: OperationActivityVisual;
  /** 지휘관 패널의 묶음 장치 — 캡션의 진척도 띠와 본문 오른쪽 위의 세션 전환 노드 줄. */
  readonly cluster: { readonly strip: ReactNode; readonly nodes: ReactNode } | null;
  /** 이 프레임이 보일 본문의 주인 — 없으면 자기 자신. 묶음의 조율자 패널이 숨은 단계를 보일 때 쓴다. */
  readonly bodyOperation: { readonly operation: OperationNode; readonly runtimeState: OperationRuntimeState | null } | null;
  readonly subject: { readonly name: string; readonly title: string; readonly tone: string | null } | null;
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
  /** War Room 무대 기하로 덮어 그리는가 — 캡션 드래그를 잠근다. */
  readonly projected: boolean;
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
  readonly onOpenMenu?: (anchor: DOMRect, returnFocus: HTMLElement | null, align: GroupContextMenuAlign) => void;
  readonly menuOpen: boolean;
  readonly onRenderHiddenDismissMenu?: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  readonly onGeometryCommit: (geometry: OperationGeometry) => void;
  readonly onDragPointer?: (pointer: OperationDragPointer) => void;
  readonly onDragRelease?: (pointer: OperationDragPointer) => void;
  readonly onOpenSnapMenu?: (anchor: DOMRect) => void;
  readonly snapHeld?: boolean;
  /** 정렬 묶음에 든 패널 — 크기 조절 핸들을 숨긴다(드래그는 그대로 둔다). */
  readonly alignHeld?: boolean;
}) {
  const descriptor = options.operationKindRegistry.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);
  const geometry = options.geometry;
  if (!descriptor?.render) return null;
  // 본문의 주인 — 보통 자기 자신, 묶음의 조율자 패널이 숨은 단계를 보일 때는 그 단계. 프레임(캡션·창 컨트롤)은 그대로 자기 것이다.
  const bodyOwner = options.bodyOperation?.operation ?? operation;
  const bodyDescriptor = bodyOwner === operation ? descriptor : options.operationKindRegistry.find((kind) => kind.pluginId === bodyOwner.pluginId && kind.type === bodyOwner.type) ?? descriptor;
  const bodyRuntimeState = options.bodyOperation ? options.bodyOperation.runtimeState : options.runtimeState;
  const bodyRender = bodyDescriptor.render ?? descriptor.render;
  const capabilities = options.capabilities;
  const onRequestCompanions = (open: boolean) => {
    if (open) {
      setActiveOperation(operation.id);
      setCompanionOperationId(operation.id);
    } else clearCompanionOperationId();
  };
  const onSetCompanionPanelVisible = (companionPanelId: string, visible: boolean) => {
    setCompanionPanelVisible(operation.id, companionPanelId, visible);
    if (visible) return;
    // companion 배치를 벗어나는 것은 **마지막** 패널을 닫을 때뿐이다.
    //
    // 이 판단은 호스트가 진다. 닫기 경로가 여럿이고(캡션 칩·단축키·패널 안 닫기) 부르는 쪽은
    // 자기 패널만 알기 때문에, 각자 "이제 배치를 걷어도 되나"를 물으면 하나를 닫는 것이 전부를
    // 닫는 일이 된다 — 실제로 그랬다. 무엇이 남았는지 아는 곳은 목록을 쥔 여기 하나다.
    const overrides = getCompanionPanelVisibilityOverrides(operation.id);
    const stillVisible = availableCompanionPanels(descriptor.companions ?? [], operation)
      .some((panel) => overrides[panel.id] ?? !panel.defaultHidden);
    if (!stillVisible) clearCompanionOperationId();
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
        snapHeld={options.snapHeld}
        resizeDisabled={options.alignHeld ?? false}
        renderHidden={options.focusLayerHidden}
        focusLayerTarget={options.maximized || options.companion}
        interactionDisabled={options.projected || options.companion || options.focusLayerHidden || options.triageStage || options.deckSlot !== null}
        accentKey={options.accentKey}
        groupName={options.groupName}
        groupColor={options.groupColor}
        theaterLabel={options.theaterLabel}
        cluster={options.cluster}
        subject={bodyOwner === operation ? null : options.subject}
        onActivate={options.onActivate}
        onClose={options.onClose}
        onMinimize={options.onMinimize}
        onMaximize={options.onMaximize}
        onRename={options.onRename}
        onOpenMenu={options.onOpenMenu}
        menuOpen={options.menuOpen}
        onRenderHiddenDismissMenu={options.onRenderHiddenDismissMenu}
        onGeometryChange={options.onGeometryChange}
        onGeometryCommit={options.onGeometryCommit}
        onDragPointer={options.onDragPointer}
        onDragRelease={options.onDragRelease}
        onOpenSnapMenu={options.onOpenSnapMenu}
        onRenderHiddenFocus={options.onRenderHiddenFocus}
        // 덱 카드에도 그린다 — 카드의 캡션은 조작면이 아니라 표식면이며, 무엇을 남길지는 CSS(.is-deck-tile)가
        // 정한다: 에이전트 사용 배지와 「사용 중」인 브라우저 버튼만 남고 나머지 액션은 숨는다.
        captionActions={(
          // 다른 플러그인의 표식(예: 연결된 목표)이 종류 소유자의 액션 앞에 선다. 그 다음이 소유자의 선반이다.
          // 본문과 같은 context로 그린다 — 캡션이 본문과 다른 사실을 말하는 프레임이 나오지 않게. 그래서 지휘관 패널이
          // 구성원의 본문을 보이는 동안 선반(브라우저·분석가·보기 전환·Use 표식)도 그 구성원의 것이다. key 에 주인을
          // 섞어 주인이 바뀌면 선반의 지역 상태가 새로 선다. 창 컨트롤·메뉴·그룹 칩·띠는 프레임(지휘관)의 것이다.
          // 실패해도 32px 밴드에 오류 상자를 세울 자리는 없으므로, 선반만 조용히 비운다.
          // (fallback을 생략하거나 null로 두면 `??`가 기본 오류 상자를 되살린다 — 빈 조각이라야 빈다.)
          <Fragment key={bodyOwner.id}>
          <OperationCaptionContributions operation={bodyOwner} language={options.language} surface="caption" />
          {bodyDescriptor.captionActions === undefined ? null : <PluginErrorBoundary fallback={<></>}>
            <PluginOperationRenderer
              active={options.active}
              capabilities={capabilities}
              geometry={geometry}
              operation={bodyOwner}
              theme={options.theme}
              language={options.language}
              viewportZoom={options.viewportZoom}
              runtimeState={bodyRuntimeState}
              onActivate={options.onActivate}
              onClose={options.onClose}
              onGeometryChange={options.onGeometryChange}
              onRequestCompanions={onRequestCompanions}
              companionsOpen={options.companion}
              hiddenCompanionPanelIds={options.hiddenCompanionPanelIds}
              onSetCompanionPanelVisible={onSetCompanionPanelVisible}
              bodyLive={!options.minimized && !options.focusLayerHidden}
              render={bodyDescriptor.captionActions}
            />
          </PluginErrorBoundary>}
          </Fragment>
        )}
      >
        {options.operationBodyPoolAvailable ? (
          <OperationBodySlot
            operationId={bodyOwner.id}
            className="canvas-operation-body-slot"
            config={{
              active: options.active,
              keyboardFocusRequestId: options.keyboardFocusRequestId,
              geometry,
              operation: bodyOwner,
              runtimeState: bodyRuntimeState,
              bodyLive: !options.minimized && !options.focusLayerHidden,
              theme: options.theme,
              language: options.language,
              zoom: options.viewportZoom,
              onActivate: options.onActivate,
              onClose: bodyOwner === operation ? options.onClose : () => selectNestedBody(operation.id, null),
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
              operation={bodyOwner}
              theme={options.theme}
              language={options.language}
              viewportZoom={options.viewportZoom}
              runtimeState={bodyRuntimeState}
              onActivate={options.onActivate}
              onClose={bodyOwner === operation ? options.onClose : () => selectNestedBody(operation.id, null)}
              onGeometryChange={options.onGeometryChange}
              onRequestCompanions={onRequestCompanions}
              companionsOpen={options.companion}
              hiddenCompanionPanelIds={options.hiddenCompanionPanelIds}
              onSetCompanionPanelVisible={onSetCompanionPanelVisible}
              bodyLive={!options.minimized && !options.focusLayerHidden}
              render={bodyRender}
            />
          </PluginErrorBoundary>
        )}
      </OperationFrame>
      {options.companions.map((companion, index) => {
        // 컴패니언(분석가·브라우저)도 본문의 주인 것이다 — 구성원의 본문을 보이는 동안 브라우저는 그 구성원의 탭을 연다.
        // 자리(레이어·기하·보이기)는 프레임의 것이라 넘겨도 같은 칸에 선다. key 에 주인을 섞어 탭 선택·주석 같은 지역 상태가
        // 주인마다 새로 서고, 떠나는 주인의 브라우저 뷰는 언마운트가 감춘다. 주인 종류가 그 컴패니언을 모르면 프레임 것을 둔다.
        const companionOwner = bodyOwner === operation || bodyDescriptor.companions?.some((candidate) => candidate.id === companion.id) ? bodyOwner : operation;
        const companionRuntimeState = companionOwner === operation ? options.runtimeState : bodyRuntimeState;
        return (
        <CompanionFrame
          key={`${companion.id}:${companionOwner.id}`}
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
                operation={companionOwner}
                theme={options.theme}
                language={options.language}
                viewportZoom={options.viewportZoom}
                runtimeState={companionRuntimeState}
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
              operation={companionOwner}
              theme={options.theme}
              language={options.language}
              viewportZoom={options.viewportZoom}
              runtimeState={companionRuntimeState}
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
        );
      })}
    </Fragment>
  );
  // 덱 칸이 있으면 그 자리로 들여보낸다 — React 트리는 그대로라 상태·이벤트·pool 배선이 모두
  // 유지되고, 바뀌는 것은 DOM 상의 부모뿐이다. 자리가 사라지면 프레임은 캔버스로 되돌아온다.
  return options.deckSlot ? createPortal(frame, options.deckSlot, operation.id) : frame;
}

/** 묶음이 이름을 주지 않았을 때의 구성원 이름 — 「목표 › 역할」 제목이면 역할, 아니면 제목 그대로. */
function nestedSubjectName(parent: OperationNode, member: OperationNode): string {
  const prefix = `${parent.title} › `;
  return member.title.startsWith(prefix) && member.title.length > prefix.length ? member.title.slice(prefix.length) : member.title;
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
