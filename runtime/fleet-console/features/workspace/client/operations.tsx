import { pluginRuntimeState } from "../../execution/client/operation-activity.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT, type CoreMessageKey } from "../../../core/client/src/i18n/index.js";

import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog, OPERATION_CATALOG_CHANGED_EVENT, wasOperationBornDormant } from "@fleet-console/sdk/operations/browser";
import type { ClientApiCapability, ClientExecutionProvider, OperationKindDescriptor } from "@fleet-console/sdk/plugin";

import { ApiError, createGroup, deleteGroup, fetchGroups, fetchOperations, fetchTheaters, patchOperation, patchTheaterOrder, renameOperation, updateGroup, type DeferredDeletionReceipt } from "../../../core/client/src/integration/api.js";
import { clearActiveOperation, shouldReleaseActiveOperation } from "../../../core/client/src/integration/active-operation-surface.js";
import { availableCompanionPanels, blocksOperationsShortcutWhileEditing, isBlockingDialogOpen, resolveCompanionShortcutToggle, resolveOperationsArrowShortcutAction, usableCompanionShortcuts } from "../../../core/client/src/integration/shortcuts.js";
import { closeOperationCompletely, minimizeOperationCompletely, resumeDormantOnOpen, resumeOperationInPlace } from "../../../core/client/src/integration/operation-actions.js";
import { forgetTheaterCompletely, registerTheaterFromPath } from "./theater.js";
import { Toast } from "../../../core/client/src/chrome/components/toast.js";
import { claimTopZIndex, consumePendingFitAllOperations, ensureDefaultGeometry, fitAllOperations, focusOperation as focusCanvasOperation, forceDropCompanionOperationId, getCanvasArenaInsets, getCanvasSnapArenaRect, getCompanionOperationId, getCompanionPanelVisibilityOverrides, getFocusLayerRevision, getAlignAll, getLoadedTheaterId, getSnapFullOperationId, getSnapshot as getCanvasSnapshot, getTheaterCanvasSnapshot, getTheaterCompanionOperationId, loadForTheater, minimizeOperations, pruneOperations, resolveLaunchGeometry, restoreOperation, restoreSnapFullOperation, setCanvasArenaInsets, setCompanionOperationId, setCompanionPanelVisible, setOperationGeometry, setTheaterOperationGeometry, toggleAlignAll, useCompanionOperationId, useMinimized, useSnapFullOperationId, type CanvasArenaInsets, type OperationGeometry } from "./canvas/canvas-store.js";
import { screenToCanvas, type CanvasPoint } from "./canvas/coordinates.js";
import { SNAP_MIN_ZOOM, SNAP_PRESETS, snapZoneHitFor } from "./canvas/snap-layouts.js";
import { applySnapZone, closeCompanionLayer, snapOperationToFullZone } from "./canvas/snap-full.js";
import { playRestoreFlight } from "./canvas/panel-motion.js";
import { OperationsCanvas } from "./canvas/canvas.js";
import { GroupContextMenu, type GroupContextMenuAlign } from "./canvas/group-context-menu.js";
import { operationAccentFromNode } from "./canvas/operation-accent.js";
import { armTriageSetAside, deferTriageOperation, disarmTriageSetAside, dismissTriageOperation, enterTriage, focusedTriageOperationId, forgetTriageOperation, getTriageSetAsideArmedId, isTriageActive, pickTriageOperation, recordTriageActivity, releaseInactiveActiveAwaitingClaim, resolveTriageQueue, restoreTriageSession, setTriageActive, useTriageActive } from "./canvas/triage-store.js";
import { createHostCapabilities } from "../../../core/client/src/integration/plugin-capabilities.js";
import { usePluginRegistry } from "../../../core/client/src/integration/plugin-registry.js";
import { RailEdgeDock, SideBarEdgeDock } from "../../../core/client/src/chrome/components/panel-edge-docks.js";
import { RightRail } from "../../../core/client/src/chrome/rail/right-rail.js";
import { OperationsSideBar } from "./sidebar/operations-side-bar.js";
import { TriageSideBar } from "./sidebar/triage-side-bar.js";
import { useContextMenuKeyboard } from "./sidebar/context-menu-keyboard.js";
import { setSideBarNarrow, sideBarOccupiedWidth, toggleSideBarStatusAxis, useQueueRailPinned, useSideBarMapNarrow, useSideBarState } from "./sidebar/operations-side-bar-store.js";
import { useRailOccupiedPx } from "../../../core/client/src/chrome/rail/rail-store.js";
import { ExpandedSurfaceLayer } from "../../../core/client/src/chrome/expanded-surface/layer.js";
import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { shouldHandleOperationsKeyboardShortcut } from "../../../core/client/src/chrome/components/keyboard-shortcuts-dialog.js";
import { companionDefaultChord, companionShortcutCommandId, isShortcutRecording, matchesChord, matchesShortcutCommand, resolveShortcutChords } from "../../../core/client/src/integration/shortcut-bindings.js";
import { cancelAddTheater, consumeOperationFocus, consumeQuickLaunch, reopenQuickLaunchWithDraft, focusCycleOperationIds, focusOperation, getState, hydrateGroups, hydrateInitialOperations, hydrateOperations, hydrateTheaters, nextOperationId, operationOrderFromNodes, requestOperationKeyboardFocus, setActiveOperation, setActiveTheater, sortOperationsByOrder } from "../../../core/client/src/integration/store.js";
import type { ConsoleState, OperationNode } from "../../../core/client/src/integration/types.js";
import { MobileShell } from "../../../core/client/src/chrome/mobile/mobile-shell.js";
import { OperationBodyPool, type OperationBodyConfig } from "../../../core/client/src/chrome/mobile/operation-body-pool.js";
import { useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import { resolveConsoleLanguage } from "../../updates/client/whatsnew-i18n.js";
import { useZenMode, useZenModeState } from "../../../core/client/src/integration/zen-mode.js";

const STABLE_RAIL_API: ClientApiCapability = createHostCapabilities().api;
const DEFAULT_SHELL_WIDTH = 560;
const DEFAULT_SHELL_HEIGHT = 360;
// 부유 크롬 카드의 가장자리 인셋(12px) + 카드와 아레나 사이 숨(12px). 카드 자신의 폭에 더해
// 아레나 인셋이 된다 — CSS의 카드 인셋(var(--space-3))과 한 값이어야 한다.
const CHROME_FLOAT_GUTTER = 24;
// 사용자 close와 PTY 자가종료가 같은 operation의 close path를 중복 실행하는 것을 막는다.
const closingOperationIds = new Set<string>();

interface OperationsProps {
  readonly state: ConsoleState;
  readonly claimBootPanelMinimization: (theaterId: string) => readonly string[] | null;
  readonly onDeferredDeletion: (deletion: DeferredDeletionReceipt | null) => void;
  readonly deletionToast?: ReactNode;
}

export function Operations({ state, claimBootPanelMinimization, onDeferredDeletion, deletionToast }: OperationsProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const snapFullOperationId = useSnapFullOperationId();
  const companionOperationId = useCompanionOperationId();
  const minimized = useMinimized();
  const registry = usePluginRegistry();
  const viewMode = useViewMode();
  const globalSettings = useGlobalSettingsStore();
  const language = resolveConsoleLanguage(globalSettings.state?.language ?? "auto");
  const t = useT();
  const [catalog, setCatalog] = useState<readonly OperationCatalogPlugin[]>([]);
  const [mutationError, setMutationError] = useState<{ readonly retry: () => void } | null>(null);
  const [operationMenu, setOperationMenu] = useState<{
    readonly operationId: string;
    readonly anchor: DOMRect;
    readonly returnFocus?: HTMLElement | null;
    readonly align?: GroupContextMenuAlign;
    readonly fromSidebar?: boolean;
  } | null>(null);
  const triageActive = useTriageActive();

  // 정렬 중 안내 — 그룹 경계 거부·스냅 단축키 안내를 토스트로 띄운다. 삭제 토스트와 같은 호스트에 산다.
  const [alignNotice, setAlignNotice] = useState<{ readonly key: CoreMessageKey; readonly nonce: number } | null>(null);
  useEffect(() => {
    if (!alignNotice) return;
    const timer = window.setTimeout(() => setAlignNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [alignNotice]);
  const handleAlignNotice = useCallback((key: CoreMessageKey) => {
    setAlignNotice({ key, nonce: Date.now() });
  }, []);

  // ── 아레나 인셋 ─────────────────────────────────────────────────────────────
  // 전면 캔버스 위 부유 크롬(사이드바·레일 카드)의 점유 폭. 크롬 구성의 소유자인 이 페이지가
  // 단일 원천으로 계산해 캔버스(prop)와 스토어(fit-all)에 같은 값을 심는다 — 주입구가 갈리면
  // 한쪽만 인셋을 아는 감사 실패 양식이 재발한다.
  const zenMode = useZenMode();
  useEffect(() => {
    if (!zenMode || !operationMenu?.fromSidebar) return;
    setOperationMenu(null);
    bodyRef.current?.focus({ preventScroll: true });
    // 진입 전에 사이드바가 연 메뉴만 회수한다. 작업면의 공용 메뉴와 이후 요청은 보존한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zenMode]);
  const sideBar = useSideBarState();
  const queueRailPinned = useQueueRailPinned();
  const mapNarrow = useSideBarMapNarrow();
  // 왼쪽 열은 64px 레일로 좁혀 설 수 있다. War Room은 레일이 기본이다 — 덱이 이미 Theater 띠와
  // 건수를 말하므로 순서와 비콘만 남기고, 고정(펼친 채 두기)하면 세션 안에서 사용자 폭이다.
  // Cruise는 사용자가 고른 배치(localStorage)다. 호버 펼침은 오버레이라 인셋에 불참한다.
  useEffect(() => {
    setSideBarNarrow(triageActive ? !queueRailPinned : mapNarrow);
  }, [triageActive, queueRailPinned, mapNarrow]);
  const railOccupiedPx = useRailOccupiedPx();
  const zenState = useZenModeState();
  const zenSideBarHidden = zenMode && !zenState.sideBarRevealed;
  const sideBarOccupiedPx = zenSideBarHidden ? 0 : sideBarOccupiedWidth(sideBar);
  const arenaInsets: CanvasArenaInsets = useMemo(() => ({
    left: sideBarOccupiedPx > 0 ? sideBarOccupiedPx + CHROME_FLOAT_GUTTER : 0,
    top: 0,
    right: railOccupiedPx > 0 ? railOccupiedPx + CHROME_FLOAT_GUTTER : 0,
    bottom: 0,
  }), [railOccupiedPx, sideBarOccupiedPx]);
  useEffect(() => {
    setCanvasArenaInsets(arenaInsets);
  }, [arenaInsets]);

  const operationOrder = useMemo(
    () => sortedTheaterOperations(state).map((operation) => operation.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.operations, state.activeTheaterId],
  );
  const stateRef = useRef(state);
  const operationMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  const focusRequestEpochRef = useRef(0);
  const catalogRequestEpochRef = useRef(0);
  const resumeBootProtectionRef = useRef<{ readonly theaterId: string; readonly operationId: string } | null>(null);
  const warRoomSessionRestoredRef = useRef(false);
  stateRef.current = state;

  // 최소화 선반에서 꺼낸 패널의 휴면 재개. 최소화 판정은 호출 분기가 진다 — 캔버스 복원과
  // focus layer 승격(최대화·companion)은 꺼내는 방식이 서로 다르고, 이미 떠 있던 패널 사이의
  // 포커스 이동은 어느 쪽에서도 재개가 아니다.
  //
  // 자동 재개는 관측된 런타임 축 위에서만 한다. 축이 권위를 갖지 못한 구간의 휴면 표시는 사실이
  // 아니라 보수적 폭백이고(pluginRuntimeState 가 degraded 를 플러그인에 넘기지 않는 것과 같은 이유),
  // 사용자가 누른 것은 "재개"가 아니라 "열기"라 그 위에서 프로세스를 되살리면 안 된다.
  //
  // 두 미관측 구간은 갈 길이 다르다. pending 은 곧 권위가 도착하므로 여는 제스처를 붙들었다가 그때
  // 다시 판정한다 — 부팅 직후가 곧 모든 패널이 최소화된 순간이라 여기서 버리면 이 기능이 가장
  // 필요한 구간에서 사라진다. degraded 는 언제 회복될지 모르는 구간이라 붙들지 않는다. 어느 쪽이든
  // 프레임의 Resume 는 그대로 있어 사용자가 직접 누를 수 있다.
  const deferredOpenResumeRef = useRef<Set<string>>(new Set());
  const resumeIfDormant = useCallback((operationId: string) => {
    const hydration = getState().operationRuntimeHydration;
    if (hydration !== "ready") {
      if (hydration === "pending") deferredOpenResumeRef.current.add(operationId);
      return;
    }
    resumeDormantOnOpen(operationId, stateRef.current.operations, registry.providers);
  }, [registry.providers]);

  useEffect(() => {
    // degraded 는 "모른다"는 뜻이다 — 붙들어 둔 제스처를 사실로 승격하지 않고 버린다.
    if (state.operationRuntimeHydration === "degraded") {
      deferredOpenResumeRef.current.clear();
      return;
    }
    if (state.operationRuntimeHydration !== "ready" || deferredOpenResumeRef.current.size === 0) return;
    const deferred = [...deferredOpenResumeRef.current];
    deferredOpenResumeRef.current.clear();
    for (const operationId of deferred) {
      // 기다리는 사이 사용자가 패널을 도로 치웠으면 그 제스처는 더 이상 유효하지 않다. 최소화는
      // Theater 별 축이므로 그 Operation 의 Theater 것을 봐야 한다 — 지금 로드된 캔버스를 보면
      // 기다리는 사이 Theater 를 옮긴 경우 남의 목록에 대고 묻게 된다.
      // 닫혔거나 사실은 살아 있었던 경우는 resumeDormantOnOpen 의 판정이 거른다.
      const operation = stateRef.current.operations.find((candidate) => candidate.id === operationId);
      if (!operation || getTheaterCanvasSnapshot(operation.theaterId).minimized.includes(operationId)) continue;
      resumeDormantOnOpen(operationId, stateRef.current.operations, registry.providers);
    }
  }, [registry.providers, state.operationRuntimeHydration]);

  const refreshCatalog = useCallback(() => {
    const epoch = ++catalogRequestEpochRef.current;
    void fetchOperationCatalog()
      .then((nextCatalog) => {
        if (catalogRequestEpochRef.current === epoch) setCatalog(nextCatalog);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadForTheater(state.activeTheaterId);
  }, [state.activeTheaterId]);

  useEffect(() => {
    recordTriageActivity(state.operations, state.operationRuntime);
  }, [state.operationRuntime, state.operations]);

  useEffect(() => {
    releaseInactiveActiveAwaitingClaim();
  }, [state.activeOperationId]);

  useEffect(() => {
    if (!triageActive) setOperationMenu(null);
  }, [triageActive]);

  useEffect(() => {
    if (!state.activeTheaterId) {
      catalogRequestEpochRef.current += 1;
      setCatalog([]);
      return;
    }
    window.addEventListener(OPERATION_CATALOG_CHANGED_EVENT, refreshCatalog);
    refreshCatalog();
    return () => {
      window.removeEventListener(OPERATION_CATALOG_CHANGED_EVENT, refreshCatalog);
      catalogRequestEpochRef.current += 1;
    };
  }, [refreshCatalog, state.activeTheaterId]);

  // Alt+화살표는 캔버스 배치 순서와 패널 문법을 공유하고, Alt+F/Alt+S는 같은 capture/editable 가드 정책을 따른다.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (viewMode.effective === "mobile") return;
      if (!shouldHandleOperationsKeyboardShortcut()) return;
      if (isShortcutRecording()) return;
      if (isBlockingDialogOpen()) return;
      const active = document.activeElement;
      const editing = active instanceof HTMLElement
        && active.matches("input, textarea, [contenteditable='true']")
        && !active.closest(".xterm");
      if (blocksOperationsShortcutWhileEditing(editing, event)) return;
      if (event.code === "Escape" && getTriageSetAsideArmedId() !== null) {
        event.preventDefault();
        event.stopImmediatePropagation();
        disarmTriageSetAside();
        return;
      }
      // Cruise 스냅 — 활성 패널을 반쪽 칸에. 캡션 메뉴와 같은 칸 수식이고 줌 정책도 같다.
      // 모두 정렬 중에는 유지 슬롯을 정렬이 소유하므로 수동 스냅은 그 패널을 빼내고 칸에 유지 없이 앉힌다.
      const snapCommand = (["operations.snap-left", "operations.snap-right"] as const)
        .find((command) => matchesShortcutCommand(event, command));
      if (snapCommand) {
        if (isTriageActive() || getCompanionOperationId() !== null) return;
        // 정렬 중 스냅 단축키는 배치 대신 안내만 띄운다 — 자리 바꾸기는 캡션 드래그가 소유한다.
        if (getAlignAll()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          setAlignNotice({ key: "canvas.align.dragToSwap", nonce: Date.now() });
          return;
        }
        const operationId = stateRef.current.activeOperationId;
        const arena = getCanvasSnapArenaRect();
        if (operationId === null || !arena || getCanvasSnapshot().viewport.zoom < SNAP_MIN_ZOOM) return;
        if (!stateRef.current.operations.some((operation) => operation.id === operationId && operation.theaterId === stateRef.current.activeTheaterId)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const hit = snapZoneHitFor(arena, SNAP_PRESETS[0]!, snapCommand === "operations.snap-left" ? 0 : 1);
        // 키보드 스냅도 유지에 든다 — 다만 후보 판은 캔버스의 드래그·메뉴 스냅만 연다.
        applySnapZone(operationId, hit, commitSnappedGeometry);
        return;
      }
      if (matchesShortcutCommand(event, "operations.fit-all")) {
        if (active instanceof HTMLElement && active.closest(".xterm")) return;
        if (isTriageActive()) return;
        if (!stateRef.current.operationsHydrated) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        fitAllOperations();
        return;
      }
      // 조합은 등록부가 정한다(기본 Alt+S/F/T). macOS의 Option+문자는 합성 문자를 내보내므로
      // 등록부는 물리 키(event.code)로 판정한다.
      if (matchesShortcutCommand(event, "operations.sort-by-status")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleSideBarStatusAxis();
        return;
      }
      if (matchesShortcutCommand(event, "operations.toggle-formation")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        // 모두 정렬 토글 — 단축키 ID는 사용자 바인딩 호환을 위해 유지한다.
        // War Room 선별 중이면 진입 훅이 선별을 먼저 끝낸다.
        toggleAlignAll();
        return;
      }
      if (matchesShortcutCommand(event, "operations.toggle-triage")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (isTriageActive()) {
          setTriageActive(false);
        } else if (stateRef.current.theaters.length > 0) {
          enterTriage(focusedTriageOperationId(document.activeElement));
        }
        return;
      }
      const snapshot = stateRef.current;
      const activeOperation = snapshot.operations.find((operation) => operation.id === snapshot.activeOperationId);
      const activeKind = activeOperation
        ? registry.operationKinds.find((kind) => kind.pluginId === activeOperation.pluginId && kind.type === activeOperation.type)
        : null;
      // 이 작전에서 사용 불가한 companion은 디스패치 대상에서 먼저 걷어낸다. 남겨두면 존재하지 않는
      // 패널로 향하는 Alt 단축키가 살아 있고, 토글의 remaining-visible 계산도 그 패널을 세게 된다.
      const activeCompanions = activeOperation
        ? availableCompanionPanels(activeKind?.companions ?? [], activeOperation)
        : [];
      const companion = activeOperation
        ? usableCompanionShortcuts(activeCompanions).find((candidate) => candidate.shortcut !== undefined
          && resolveShortcutChords(companionShortcutCommandId(activeOperation.pluginId, candidate.id), [companionDefaultChord(candidate.shortcut.code)])
            .some((chord) => matchesChord(event, chord)))
        : undefined;
      if (activeOperation && companion?.shortcut) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return;
        const toggle = resolveCompanionShortcutToggle({
          companions: activeCompanions,
          targetId: companion.id,
          clusterIds: companion.shortcut.clusterIds,
          companionsOpen: getCompanionOperationId() === activeOperation.id,
          visibilityOverrides: getCompanionPanelVisibilityOverrides(activeOperation.id),
        });
        if (toggle.openLayer) setCompanionOperationId(activeOperation.id);
        for (const change of toggle.visibilityChanges) {
          setCompanionPanelVisible(activeOperation.id, change.id, change.visible);
        }
        if (toggle.closeLayer) closeCompanionLayer(commitSnappedGeometry);
        return;
      }
      // Alt+화살표 넷은 한 문법 묶음이라 재배정 대상이 아니다 — 여기서만 Alt를 직접 본다.
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const theaterId = snapshot.activeTheaterId;
      const triageActive = isTriageActive();
      const arrowAction = resolveOperationsArrowShortcutAction(triageActive, event.code);
      if (arrowAction === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat && (arrowAction === "snap-full"
        || arrowAction === "minimize"
        || arrowAction === "triage-set-aside")) return;
      if ((arrowAction === "snap-full" || arrowAction === "minimize" || arrowAction === "triage-noop" || arrowAction === "triage-set-aside")
        && getCompanionOperationId() !== null) return;
      if (triageActive) {
        if (arrowAction === "triage-noop") return;
        const stageId = document.querySelector<HTMLElement>(".canvas-operation.is-triage-stage[data-operation-id]")?.dataset.operationId;
        if (!stageId) return;
        const queue = resolveTriageQueue(snapshot.operations, snapshot.operationRuntime);
        if (!queue.some((entry) => entry.operation.id === stageId)) return;
        if (arrowAction === "triage-defer") {
          deferTriageOperation(stageId);
        } else if (getTriageSetAsideArmedId() === stageId) {
          disarmTriageSetAside();
          dismissTriageOperation(stageId);
        } else {
          armTriageSetAside(stageId);
        }
        return;
      }
      // Alt 순환 순서를 Left SideBar 표시 순서(비-collapsed 그룹 order → 그룹 내 operationOrder → ungrouped)와 정확히 일치시킨다.
      const canvas = getCanvasSnapshot();
      const theaterOperations = snapshot.operations.filter((operation) => operation.theaterId === snapshot.activeTheaterId);
      // 사이드바 'Sort by status'(statusAxis)는 순환 순서에 관여하지 않는다. 캔버스 패널 배치는 그룹/order
      // 순서 그대로이므로 상태 랭크로 순환하면 포커스가 화면 배치와 어긋나 튄다(PR#361 계약 되돌림).
      const order = focusCycleOperationIds(
        theaterOperations,
        snapshot.groups.filter((g) => g.theaterId === snapshot.activeTheaterId),
        operationOrderFromNodes(theaterOperations),
        canvas.collapsedGroups,
        canvas.minimized,
      );
      if (arrowAction === "snap-full" || arrowAction === "minimize") {
        const operationId = snapshot.activeOperationId;
        if (!operationId || !theaterOperations.some((operation) => operation.id === operationId) || canvas.minimized.includes(operationId)) return;
        // 모두 정렬·War Room은 배치를 쥐고 있어 전체 칸이 없다 — ↑는 아무 일도 하지 않고, ↓는 최소화로 남는다.
        const snapFullAvailable = !getAlignAll();
        if (arrowAction === "snap-full") {
          if (snapFullAvailable) snapOperationToFullZone(operationId, commitSnappedGeometry);
          return;
        }
        // ↓는 전체 칸을 쥔 패널이면 직전 자리로 되돌리고(캡션 ⤡·더블클릭과 같은 복원), 아니면 최소화한다.
        if (snapFullAvailable && restoreSnapFullOperation(operationId)) {
          commitSnappedGeometry(operationId);
          return;
        }
        const currentIndex = order.indexOf(operationId);
        if (currentIndex === -1) return;
        const nextId = order.length > 1 ? order[(currentIndex + 1) % order.length] ?? null : null;
        minimizeOperationCompletely(operationId);
        setActiveOperation(nextId);
        return;
      }
      if (order.length === 0) return;
      const currentId = getCompanionOperationId() ?? getSnapFullOperationId() ?? stateRef.current.activeOperationId;
      const nextId = nextOperationId(order, currentId, arrowAction === "focus-next" ? 1 : -1);
      if (!nextId) return;
      // 패널 사이를 걷는 이동이다 — 지휘관 패널이 보던 구성원 본문은 그대로 둔다.
      void routeOperationFocus(nextId, registry.operationKinds, STABLE_RAIL_API, focusRequestEpochRef, () => focusOperation(nextId, { keepBody: true }), resumeIfDormant);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [companionOperationId, registry.operationKinds, resumeIfDormant, snapFullOperationId, viewMode.effective]);

  // Map이 아닌 곳(좌·우 사이드바, 레일, 커맨드 밴드 크롬 등)을 누르면 패널 활성화를 푼다.
  // 칩·브레드크럼·패널은 가드가 유지하고, 빈 바다 해제는 캔버스 onClick이 맡는다.
  useEffect(() => {
    if (viewMode.effective === "mobile") return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (stateRef.current.activeOperationId === null) return;
      if (!shouldReleaseActiveOperation(event.target)) return;
      clearActiveOperation();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [viewMode.effective]);

  useEffect(() => {
    const resumeBootProtection = resumeBootProtectionRef.current?.theaterId === state.activeTheaterId
      ? resumeBootProtectionRef.current.operationId
      : null;
    if (resumeBootProtection !== null || viewMode.effective === "mobile") resumeBootProtectionRef.current = null;
    if (viewMode.effective === "mobile") return;
    for (const operation of sortedTheaterOperations(state)) {
      ensureDefaultGeometry(operation.id, operation.geometry, wasOperationBornDormant(operation.payload));
    }
    if (!state.operationsHydrated) return;
    pruneOperations(operationOrder);
    // 각 Theater를 세션 중 처음 열 때 한 번, 그 Theater의 부팅 시점 기존 패널을 최소화한다.
    // (App boot 활성 Theater뿐 아니라 선택·전환으로 처음 진입하는 Theater도 포함 — Map을 항상 깨끗하게 연다.)
    // 이후 생성·route 재진입·같은 세션 재진입은 대상에서 빠져, 사용자의 restore를 보존한다.
    if (!state.activeTheaterId) return;
    const bootOperationIds = claimBootPanelMinimization(state.activeTheaterId);
    if (bootOperationIds === null) return;
    // 선택·재개로 진입한 패널은 최소화에서 제외해 곧바로 표면화한다 — 선택한 패널만 하나씩 노출.
    const protectedIds = new Set([
      stateRef.current.pendingOperationFocus,
      resumeBootProtection,
      getCompanionOperationId(),
      getSnapFullOperationId(),
    ].filter((id): id is string => id !== null));
    minimizeOperations(bootOperationIds.filter((id) => !protectedIds.has(id)));
  }, [claimBootPanelMinimization, operationOrder, state.activeTheaterId, state.operationsHydrated, viewMode.effective]);

  // War Room은 전역 모드라 Theater 로드가 되살리지 못한다 — 탭 세션에 적힌 모드를 부팅 때 한 번만
  // 복원한다. 부팅 최소화 뒤에 두어, 복원이 지우는 focus layer가 최소화 보호 대상 판정을 앞지르지 않게 한다.
  // 이후 사용자가 나가면 세션 표식도 함께 지워지므로 이 effect가 다시 들어오지 않는다.
  useEffect(() => {
    if (warRoomSessionRestoredRef.current || viewMode.effective === "mobile") return;
    if (!state.operationsHydrated || state.theaters.length === 0) return;
    warRoomSessionRestoredRef.current = true;
    restoreTriageSession();
  }, [state.operationsHydrated, state.theaters.length, viewMode.effective]);

  useEffect(() => {
    if (!state.operationsHydrated) return;
    consumePendingFitAllOperations();
  }, [state.activeTheaterId, state.operationsHydrated]);

  const focusMapOperation = useCallback((operationId: string) => {
    const operation = stateRef.current.operations.find((candidate) => candidate.id === operationId);
    if (!operation) return;
    if (isTriageActive()) {
      pickTriageOperation(operationId);
      return;
    }
    const snapshot = getCanvasSnapshot();
    const geometry = snapshot.operations[operationId] ?? operation.geometry ?? ensurePluginGeometry(operation);
    // 캔버스 store에 처음 심는 좌표도 생성과 같은 규율을 탄다 — Station Keeping이면 정착 후 심는다.
    if (!snapshot.operations[operationId]) setOperationGeometry(operationId, resolveLaunchGeometry(operation.theaterId, geometry));
    const wasMinimized = snapshot.minimized.includes(operationId);
    // 복원과 활성화를 같은 동기 실행에서 끝내 Canvas의 최소화-active 정리 effect보다 먼저 상태를 확정한다.
    if (wasMinimized) playRestoreFlight(operationId);
    restoreOperation(operationId);
    setActiveOperation(operationId);
    const viewportSize = viewportSizeFor(bodyRef.current);
    if (viewportSize) focusCanvasOperation(operationId, viewportSize);
    if (wasMinimized) resumeIfDormant(operationId);
  }, [registry.providers, resumeIfDormant]);

  // 검색·ALERTS 등에서 들어온 일회성 이동 요청을 처리한다.
  useEffect(() => {
    const operationId = state.pendingOperationFocus;
    if (operationId === null) return;
    if (viewMode.effective === "mobile") {
      const operation = state.operations.find((candidate) => candidate.id === operationId && candidate.theaterId === state.activeTheaterId);
      if (operation) {
        const url = new URL(window.location.href);
        url.searchParams.set("op", operationId);
        if (new URL(window.location.href).searchParams.get("op") !== operationId) {
          window.history.pushState({ ...window.history.state, fleetMobileOperation: true }, "", url);
        }
        window.dispatchEvent(new Event("popstate"));
      }
      consumeOperationFocus();
      return;
    }
    // loadForTheater effect가 먼저 도착 Theater의 focus layer를 복원한다.
    // Snap 전체 힌트가 있으면 먼저 앉혀 보고, 앉힐 수 없으면 같은 일반 이동으로 폴백한다.
    if (state.pendingOperationFocusSnap === true && trySnapFullFocus(operationId, resumeIfDormant)) {
      consumeOperationFocus();
      return;
    }
    void routeOperationFocus(operationId, registry.operationKinds, STABLE_RAIL_API, focusRequestEpochRef, () => focusMapOperation(operationId), resumeIfDormant);
    consumeOperationFocus();
  }, [focusMapOperation, registry.operationKinds, resumeIfDormant, state.activeTheaterId, state.operations, state.pendingOperationFocus, state.pendingOperationFocusSnap, viewMode.effective]);

  const canLaunch = !!state.activeTheaterId && !state.addingTheater;
  const theaterOperations = (state.operations ?? []).filter((op) => op.theaterId === state.activeTheaterId);
  // 본문 풀은 구성원까지 싣는다 — 지휘관 패널이 본문 교체로 구성원의 세션을 보이려면 그 본문이 주차돼 있어야 한다.
  const pooledOperations = useMemo(() => {
    const inScope = (op: OperationNode) => triageActive || op.theaterId === state.activeTheaterId;
    return [...state.operations.filter(inScope), ...state.nestedOperations.filter(inScope)];
  }, [state.activeTheaterId, state.nestedOperations, state.operations, triageActive]);
  const renderKindIcon = useCallback((pluginId: string | null, kind: OperationLaunchKind): ReactNode => {
    const plugin = registry.providers.find((p) => p.id === pluginId);
    return plugin?.renderLaunchIcon?.(kind) ?? null;
  }, [registry.providers]);

  const handleCanvasLaunchKind = useCallback((
    pluginId: string | null,
    kind: OperationLaunchKind,
    canvasPoint: CanvasPoint,
    theaterId?: string,
    variant?: Readonly<Record<string, string>>,
  ) => {
    const launchTheaterId = theaterId ?? stateRef.current.activeTheaterId;
    if (!launchTheaterId) return;
    // Station Keeping이 켜진 Theater의 생성 좌표는 전부 정착을 거친다 — 어느 진입 경로든 같은 규율.
    const geometry = resolveLaunchGeometry(launchTheaterId, { ...canvasPointToGeometry(canvasPoint), zIndex: claimTopZIndex() });
    void launchViaPlugin(pluginId, kind, geometry, launchTheaterId, registry.providers, variant);
  }, [registry.providers]);

  const handleSideBarLaunchKind = useCallback((
    pluginId: string | null,
    kind: OperationLaunchKind,
    variant?: Readonly<Record<string, string>>,
  ) => {
    const launchTheaterId = stateRef.current.activeTheaterId;
    if (!launchTheaterId) return;
    const canvasPoint = canvasCenterPoint(bodyRef.current);
    const geometry = resolveLaunchGeometry(launchTheaterId, { ...canvasPointToGeometry(canvasPoint), zIndex: claimTopZIndex() });
    void launchViaPlugin(pluginId, kind, geometry, launchTheaterId, registry.providers, variant);
  }, [registry.providers]);

  const handleRailLaunchOperation = useCallback((pluginId: string | null, kind: OperationLaunchKind) => {
    handleSideBarLaunchKind(pluginId, kind);
  }, [handleSideBarLaunchKind]);

  // Quick Launch 컴포저가 남긴 의도를 여기서 소비한다. 대상 Theater로의 전환이 실제로 반영된 뒤에만
  // 실행해야 한다 — activeTheaterId가 아직 이전 Theater면 launch 좌표와 포커스 승계가 엉뚱한 캔버스로 간다.
  useEffect(() => {
    const request = state.pendingQuickLaunch;
    if (!request || request.theaterId !== state.activeTheaterId) return;
    consumeQuickLaunch();
    const canvasPoint = canvasCenterPoint(bodyRef.current);
    const geometry = resolveLaunchGeometry(request.theaterId, { ...canvasPointToGeometry(canvasPoint), zIndex: claimTopZIndex() });
    // 실행이 거절되면(모델 비활성·CLI 미가용·프롬프트 전달 불가) 초안을 잃지 않게 컴포저를 되연다.
    // 컴포저는 결과를 기다리지 않는 구조라, 사용자에게 되돌아오는 경로는 여기뿐이다.
    void launchViaPlugin(request.pluginId, request.kind, geometry, request.theaterId, registry.providers, request.variant)
      .then(() => {
        // 발사가 확정된 첨부의 미리보기 object URL은 여기서만 회수할 수 있다 — 컴포저는 결과를
        // 기다리지 않고 닫혔고, 거절이었다면 이 URL이 칩 복원에 다시 쓰인다.
        for (const attachment of request.attachments ?? []) URL.revokeObjectURL(attachment.previewUrl);
      })
      .catch((error: unknown) => {
        const draft = request.variant.prompt;
        if (!draft) return;
        // 플러그인 클라이언트가 서버 error 코드를 message로 실어 던진다. 코드를 모르면 일반 문구로 떨어진다.
        // 프롬프트를 몇 글자 줄여야 하는지도 같은 에러에 붙어 온다 — 플러그인 타입을 끌어오지 않으려고
        // 구조로만 읽는다(코드를 message로 읽는 위 계약과 같은 형태).
        // 첨부 자취도 초안과 함께 되돌린다 — 서버 파일은 미발사분으로 남아 재시도가 같은 id를 싣는다.
        reopenQuickLaunchWithDraft(
          draft,
          error instanceof Error ? error.message : null,
          readShortenByChars(error),
          request.attachments ?? null,
        );
      });
  }, [registry.providers, state.activeTheaterId, state.pendingQuickLaunch]);

  const handleLaunchAtGeometry = useCallback((pluginId: string | null, kind: OperationLaunchKind, geometry: OperationGeometry) => {
    const launchTheaterId = stateRef.current.activeTheaterId;
    if (!launchTheaterId) return;
    void launchViaPlugin(pluginId, kind, resolveLaunchGeometry(launchTheaterId, geometry), launchTheaterId, registry.providers);
  }, [registry.providers]);

  const handleFocus = useCallback((operationId: string) => {
    const operation = stateRef.current.operations.find((candidate) => candidate.id === operationId);
    if (!operation) return;
    // 선별 중에는 전 Theater가 마운트이므로 focusOperation의 Theater 전환을 타지 않고 바로 지목한다 —
    // 전환을 타면 loadForTheater가 목적지의 저장된 focus layer를 선별 위로 부활시킨다.
    if (isTriageActive()) {
      void routeOperationFocus(operationId, registry.operationKinds, STABLE_RAIL_API, focusRequestEpochRef, () => focusMapOperation(operationId), resumeIfDormant);
      return;
    }
    if (operation.theaterId !== stateRef.current.activeTheaterId) {
      focusRequestEpochRef.current += 1;
      focusOperation(operationId);
      return;
    }
    void routeOperationFocus(operationId, registry.operationKinds, STABLE_RAIL_API, focusRequestEpochRef, () => focusMapOperation(operationId), resumeIfDormant);
  }, [focusMapOperation, registry.operationKinds, resumeIfDormant]);

  // 빈 캔버스의 일괄 열기 — 대기 전원을 복원하고 「모두 열어 정렬」로 나란히 착지시킨다.
  // 목록 순서(updatedAt 내림차순)의 첫 항목을 활성으로 둔다. 비행 연출은 N개분이라 생략하고
  // 정렬 진입 전이가 그 역할을 대신한다.
  const handleOpenAll = useCallback((operationIds: readonly string[]) => {
    if (operationIds.length === 0) return;
    for (const operationId of operationIds) restoreOperation(operationId);
    setActiveOperation(operationIds[0] ?? null);
    if (!getAlignAll()) toggleAlignAll();
  }, []);

  const handleMinimize = useCallback((operationId: string) => {
    minimizeOperationCompletely(operationId);
  }, []);

  const handleResume = useCallback((operationId: string) => {
    const operation = stateRef.current.operations.find((candidate) => candidate.id === operationId);
    if (!operation) return;
    const resume = () => resumeOperationInPlace(operationId, stateRef.current.operations, registry.providers, handleFocus);
    if (operation.theaterId !== stateRef.current.activeTheaterId) {
      resumeBootProtectionRef.current = { theaterId: operation.theaterId, operationId };
      setActiveTheater(operation.theaterId);
      resume();
      return;
    }
    resume();
  }, [handleFocus, registry.providers]);

  const runMutation = useCallback((task: () => Promise<void>, rollback: () => Promise<void>) => {
    const attempt = () => {
      void task()
        .then(() => setMutationError(null))
        .catch(() => {
          void rollback().finally(() => setMutationError({ retry: attempt }));
        });
    };
    attempt();
  }, []);

  const refreshOperations = useCallback(
    () => fetchOperations(null).then(hydrateOperations),
    [],
  );
  const refreshGroups = useCallback(
    () => fetchGroups(null).then(hydrateGroups),
    [],
  );
  const refreshTheaters = useCallback(
    () => fetchTheaters(null).then(hydrateTheaters),
    [],
  );
  const refreshOperationsAndGroups = useCallback(
    () => Promise.all([refreshOperations(), refreshGroups()]).then(() => undefined),
    [refreshGroups, refreshOperations],
  );

  const handleSetAccent = useCallback((operationId: string, accentKey: string | null) => {
    runMutation(
      () => patchOperation(operationId, { accent: accentKey }).then(refreshOperations),
      refreshOperations,
    );
  }, [refreshOperations, runMutation]);

  const handleRename = useCallback((operationId: string, title: string) => {
    runMutation(
      () => renameOperation(operationId, title).then(refreshOperations),
      refreshOperations,
    );
  }, [refreshOperations, runMutation]);

  const handleSetGroupId = useCallback((operationId: string, groupId: string | null) => {
    runMutation(
      () => patchOperation(operationId, { groupId }).then(refreshOperations),
      refreshOperations,
    );
  }, [refreshOperations, runMutation]);

  const handleCreateGroup = useCallback((theaterId: string, name: string, operationId?: string) => {
    // 재시도가 POST를 다시 치면 서버가 새 id를 발급해 그룹이 쌓인다 — 첫 성공 id를 붙잡아
    // 거절된 배정·새로고침만 다시 한다.
    let createdGroupId: string | null = null;
    runMutation(
      async () => {
        const group = createdGroupId
          ? { id: createdGroupId }
          : await createGroup({ theaterId, name, color: "blue" });
        createdGroupId = group.id;
        if (operationId) await patchOperation(operationId, { groupId: group.id });
        await refreshOperationsAndGroups();
      },
      refreshOperationsAndGroups,
    );
  }, [refreshOperationsAndGroups, runMutation]);

  const openOperationMenu = useCallback((operationId: string, anchor: DOMRect, returnFocus?: HTMLElement | null, align?: GroupContextMenuAlign) => {
    if (!stateRef.current.operations.some((operation) => operation.id === operationId)) return;
    setOperationMenu({ operationId, anchor, returnFocus, align });
  }, []);
  // 포커스 복귀는 갱신 함수 밖에서 한다 — setState updater는 순수해야 하고, StrictMode의
  // 이중 호출에서 focus()가 두 번 실행된다.
  const closeOperationMenu = useCallback(() => {
    if (document.hasFocus()) operationMenuReturnFocusRef.current?.focus();
    setOperationMenu(null);
  }, []);
  // 주인 패널이 focus layer 뒤로 숨었을 때의 회수. 보이지 않는 패널의 메뉴가 조작 가능한 채로
  // 남지 않도록 거두되, 포커스는 되돌리지 않는다 — 되돌릴 트리거가 방금 inert가 된 그 패널 안에
  // 있고, 포커스 이관은 프레임이 이어서 전면 패널로 수행한다.
  const dismissOperationMenu = useCallback((operationId: string) => {
    setOperationMenu((current) => current?.operationId === operationId ? null : current);
  }, []);
  // 메뉴는 페이지가 소유하므로 주인 패널이 언마운트돼도 저 혼자 살아남는다. Theater 전환과
  // War Room 토글은 무대의 패널 구성을 통째로 갈아치우니, 그 전환 자체를 회수 신호로 삼는다
  // (팔레트의 switch-theater처럼 메뉴를 닫지 않는 경로로도 전환이 들어온다). 여기서도 포커스는
  // 되돌리지 않는다 — 되돌릴 트리거가 방금 사라진 패널 안에 있다.
  useEffect(() => {
    setOperationMenu(null);
  }, [state.activeTheaterId, triageActive]);
  const menuOperation = operationMenu
    ? state.operations.find((operation) => operation.id === operationMenu.operationId) ?? null
    : null;
  operationMenuReturnFocusRef.current = operationMenu?.returnFocus ?? null;
  useContextMenuKeyboard({
    open: menuOperation !== null,
    menuSelector: '.group-context-menu-card[role="menu"]',
    returnFocusRef: operationMenuReturnFocusRef,
    onEscape: closeOperationMenu,
  });

  const handleSetGroupColor = useCallback((groupId: string, color: string | null) => {
    if (!color) return;
    runMutation(
      () => updateGroup(groupId, { color }).then(refreshGroups),
      refreshGroups,
    );
  }, [refreshGroups, runMutation]);

  const handleRenameGroup = useCallback((groupId: string, name: string) => {
    runMutation(
      () => updateGroup(groupId, { name }).then(refreshGroups),
      refreshGroups,
    );
  }, [refreshGroups, runMutation]);

  const handleReorderGroups = useCallback((orderedGroupIds: readonly string[]) => {
    // 재시도마다 PATCH를 새로 만든다 — 바깥에서 만든 Promise를 다시 넘기면 이미 거절된
    // 결과만 보고 네트워크를 다시 타지 않는다.
    runMutation(
      () => {
        const groupById = new Map(stateRef.current.groups.map((group) => [group.id, group]));
        return settleReorderPatches(orderedGroupIds.flatMap((groupId, order) => {
          const group = groupById.get(groupId);
          if (!group || group.order === order) return [];
          return [updateGroup(groupId, { order })];
        })).then(refreshGroups);
      },
      refreshGroups,
    );
  }, [refreshGroups, runMutation]);

  const handleReorderTheaters = useCallback((orderedTheaterIds: readonly string[]) => {
    runMutation(
      () => {
        const theaterById = new Map(stateRef.current.theaters.map((theater) => [theater.id, theater]));
        return settleReorderPatches(orderedTheaterIds.flatMap((theaterId, order) => {
          const theater = theaterById.get(theaterId);
          if (!theater || theater.order === order) return [];
          return [patchTheaterOrder(theaterId, order)];
        })).then(refreshTheaters);
      },
      refreshTheaters,
    );
  }, [refreshTheaters, runMutation]);

  const handleUngroupAll = useCallback((groupId: string) => {
    // DELETE가 이미 성공한 뒤 새로고침만 거절되면 재시도가 같은 id를 다시 지우려 한다 —
    // 서버는 404 group_not_found 를 주고 배너가 안 내려간다. 첫 성공 뒤에는 새로고침만 다시 한다.
    let deleted = false;
    runMutation(
      async () => {
        if (!deleted) {
          try {
            await deleteGroup(groupId);
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
          }
          deleted = true;
        }
        await refreshOperationsAndGroups();
      },
      refreshOperationsAndGroups,
    );
  }, [refreshOperationsAndGroups, runMutation]);

  const handleClose = useCallback((operationId: string) => {
    if (closingOperationIds.has(operationId)) return;
    if (getCompanionOperationId() === operationId) forceDropCompanionOperationId();
    if (isTriageActive()) dismissTriageOperation(operationId);
    closingOperationIds.add(operationId);
    const pluginId = stateRef.current.operations.find((op) => op.id === operationId)?.pluginId;
    const plugin = (pluginId !== undefined ? registry.providers.find((p) => p.id === pluginId) : null) ?? null;
    void closeOperationCompletely(operationId, plugin)
      .then((deletion) => {
        forgetTriageOperation(operationId);
        onDeferredDeletion(deletion);
      })
      .finally(() => closingOperationIds.delete(operationId));
  }, [onDeferredDeletion, registry.providers]);

  const poolCapabilities = useMemo(() => createHostCapabilities(() => {
    void fetchOperations(null).then(hydrateOperations).catch(() => {});
  }), []);
  const defaultBodyConfig = useCallback((operation: OperationNode): OperationBodyConfig => ({
    active: state.activeOperationId === operation.id,
    geometry: operation.geometry ?? ensurePluginGeometry(operation),
    operation,
    runtimeState: pluginRuntimeState(state.operationRuntime, state.operationRuntimeHydration, operation.id),
    // 슬롯이 붙기 전 주차 본문. 보이는 프레임이 publish하면 그 값이 이 기본을 덮는다.
    bodyLive: false,
    theme: state.activeTheme,
    language,
    zoom: 1,
    onActivate: () => setActiveOperation(operation.id),
    onClose: () => handleClose(operation.id),
    onGeometryChange: () => {},
    onRequestCompanions: () => {},
    companionsOpen: false,
    hiddenCompanionPanelIds: [],
    onSetCompanionPanelVisible: () => {},
  }), [handleClose, language, state.activeOperationId, state.activeTheme]);

  const handleAddTheater = useCallback(async (path: string) => {
    await registerTheaterFromPath(path);
  }, []);

  const handleForgetTheater = useCallback(async (theaterId: string) => {
    onDeferredDeletion(await forgetTheaterCompletely(theaterId));
  }, [onDeferredDeletion]);

  const shell = viewMode.effective === "mobile" ? (
    <MobileShell
      operations={theaterOperations}
      activeOperationId={state.activeOperationId}
      operationRuntime={state.operationRuntime}
      operationRuntimeHydration={state.operationRuntimeHydration}
      operationNotifications={state.operationNotifications}
      theaterLabel={state.theaters.find((theater) => theater.id === state.activeTheaterId)?.label ?? null}
      theme={state.activeTheme}
      language={language}
      operationKinds={registry.operationKinds}
      capabilities={poolCapabilities}
      onSelectOperation={setActiveOperation}
      onCloseOperation={handleClose}
    />
  ) : (
    <div className="console-body is-canvas">
      {mutationError ? (
        <p className="operations-mutation-error" role="alert">
          {t("operations.mutation.failed")}
          <button type="button" className="operations-mutation-retry" onClick={mutationError.retry}>
            {t("operations.mutation.retry")}
          </button>
        </p>
      ) : null}
      <div className="zen-sidebar-chrome" inert={zenSideBarHidden} hidden={zenSideBarHidden}>
      {triageActive ? (
        <TriageSideBar
          theaters={state.theaters}
          operations={state.operations}
          groups={state.groups}
          operationRuntime={state.operationRuntime}
          operationNotifications={state.operationNotifications}
          catalog={catalog}
          plugins={registry.providers}
          renderKindIcon={renderKindIcon}
          canLaunch={canLaunch}
          onLaunchKind={handleSideBarLaunchKind}
          onPick={pickTriageOperation}
          onClose={handleClose}
          onRename={handleRename}
          onOpenOperationMenu={(operationId, anchor, returnFocus) => setOperationMenu({ operationId, anchor, returnFocus, fromSidebar: true })}
        />
      ) : (
      <OperationsSideBar
        theaters={state.theaters}
        activeTheaterId={state.activeTheaterId}
        operations={state.operations}
        groups={state.groups}
        minimized={minimized}
        activeOperationId={state.activeOperationId}
        operationNotifications={state.operationNotifications}
        catalog={catalog}
        canLaunch={canLaunch}
        addingTheater={state.addingTheater}
        theaterError={state.theaterError}
        renderKindIcon={renderKindIcon}
        onLaunchKind={handleSideBarLaunchKind}
        onClose={handleClose}
        onMinimize={handleMinimize}
        onFocus={handleFocus}
        onResume={handleResume}
        onSetAccent={handleSetAccent}
        onRename={handleRename}
        onSetGroupId={handleSetGroupId}
        onCreateGroup={handleCreateGroup}
        onSetGroupColor={handleSetGroupColor}
        onRenameGroup={handleRenameGroup}
        onReorderGroups={handleReorderGroups}
        onReorderTheaters={handleReorderTheaters}
        onUngroupAll={handleUngroupAll}
        onSelectTheater={setActiveTheater}
        onAddTheater={handleAddTheater}
        onCancelAddTheater={cancelAddTheater}
        onForgetTheater={handleForgetTheater}
      />
      )}
      </div>
      <div className="operations-center-stage" ref={bodyRef} tabIndex={-1}>
        <OperationsCanvas
          state={state}
          arenaInsets={arenaInsets}
          catalog={catalog}
          canLaunch={canLaunch}
          renderKindIcon={renderKindIcon}
          onLaunchKind={handleCanvasLaunchKind}
          onLaunchAtGeometry={handleLaunchAtGeometry}
          onRefreshCatalog={refreshCatalog}
          onClose={handleClose}
          onFocus={handleFocus}
          onOpenAll={handleOpenAll}
          onRename={handleRename}
          onOpenOperationMenu={openOperationMenu}
          openMenuOperationId={operationMenu?.operationId ?? null}
          onDismissOperationMenu={dismissOperationMenu}
          onAlignNotice={handleAlignNotice}
        />
      </div>
      <div className="operations-toast-region" style={{ left: arenaInsets.left, right: arenaInsets.right }}>
        <div className="app-toast-host">{deletionToast}{alignNotice ? <Toast key={alignNotice.nonce} open tone="info" title={t(alignNotice.key)} onDismiss={() => setAlignNotice(null)} /> : null}</div>
      </div>
      <RightRail theaterId={state.activeTheaterId} api={STABLE_RAIL_API} onLaunchOperation={handleRailLaunchOperation} />
      {/* 접힌 패널의 문 — 각 카드가 소멸한 자리의 엣지에 서고, 두 사이드바(Map·War Room)가
          같은 접힘 상태를 쓰므로 독도 모드와 무관하게 이 페이지가 한 번만 세운다. */}
      {zenMode ? null : <><SideBarEdgeDock /><RailEdgeDock /></>}
      {/* Operation 메뉴는 War Room 전용이 아니다 — 사이드바 우클릭·War Room 카드·패널 캡션의
          More 버튼이 모두 같은 메뉴를 연다. */}
      {operationMenu && menuOperation ? (
        <GroupContextMenu
          kind="chip"
          operation={menuOperation}
          groups={state.groups.filter((group) => group.theaterId === menuOperation.theaterId)}
          accentKey={getTheaterCanvasSnapshot(menuOperation.theaterId).operationAccent[menuOperation.id]
            ?? operationAccentFromNode(menuOperation)}
          anchor={operationMenu.anchor}
          align={operationMenu.align}
          actions={{
            onSetAccent: (key) => handleSetAccent(menuOperation.id, key),
            onSetGroupId: (groupId) => handleSetGroupId(menuOperation.id, groupId),
            onCreateGroup: (name) => handleCreateGroup(menuOperation.theaterId, name, menuOperation.id),
          }}
          onClose={closeOperationMenu}
        />
      ) : null}
      <ExpandedSurfaceLayer />
    </div>
  );
  return (
    <OperationBodyPool
      operations={pooledOperations}
      operationKinds={registry.operationKinds}
      capabilities={poolCapabilities}
      defaultConfig={defaultBodyConfig}
    >
      {shell}
    </OperationBodyPool>
  );
}

// 모든 사용자 포커스 진입점은 현재 로드된 Theater의 live 표시 상태만으로 같은 순서를 적용한다.
async function routeOperationFocus(operationId: string, operationKinds: readonly OperationKindDescriptor[], api: ClientApiCapability, requestEpochRef: { current: number }, focusMap: () => void, resumeIfDormant: (operationId: string) => void): Promise<void> {
  const requestEpoch = ++requestEpochRef.current;
  const triageOperation = getState().operations.find((candidate) => candidate.id === operationId);
  if (triageOperation && isTriageActive()) {
    // 선별 중 focusOperation은 store 가드(registerFocusTheaterSwitchSuppression)로 Theater를
    // 전환하지 않는다 — 지목만으로 무대가 서고, 활성 Theater는 그대로다.
    pickTriageOperation(operationId);
    requestOperationKeyboardFocus(operationId);
    return;
  }
  const focusLayerRevision = getFocusLayerRevision();
  const currentCompanionOperationId = getCompanionOperationId();
  if (currentCompanionOperationId !== null) {
    if (currentCompanionOperationId === operationId) {
      setActiveOperation(operationId);
      requestOperationKeyboardFocus(operationId);
      return;
    }
    const operation = getState().operations.find((candidate) => candidate.id === operationId);
    const operationWasMinimized = getCanvasSnapshot().minimized.includes(operationId);
    const descriptor = operation && operationKinds.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);
    // 이 작전에서 사용 가능한 companion이 하나도 없으면 layer를 여는 것 자체가 빈 껍데기다.
    // 선언 목록이 아니라 availability를 통과한 목록으로 판단한다.
    const descriptorCompanions = operation && descriptor
      ? availableCompanionPanels(descriptor.companions ?? [], operation)
      : [];
    let canOpenCompanions = true;
    if (operation && descriptorCompanions.length > 0 && descriptor && descriptor.canOpenCompanions) {
      try {
        canOpenCompanions = await descriptor.canOpenCompanions({ api, operation });
      } catch {
        canOpenCompanions = false;
      }
      // readiness 확인 중 사용자가 Exit·다른 Operation·다른 Theater로 이동하거나 대상을 새로 숨겼으면 오래된 결과를 버린다.
      const liveState = getState();
      const liveOperation = liveState.operations.find((candidate) => candidate.id === operationId);
      const operationWasHidden = !operationWasMinimized && getCanvasSnapshot().minimized.includes(operationId);
      if (requestEpochRef.current !== requestEpoch || getFocusLayerRevision() !== focusLayerRevision || getCompanionOperationId() !== currentCompanionOperationId || liveState.activeTheaterId !== operation.theaterId || getLoadedTheaterId() !== operation.theaterId || operationWasHidden || closingOperationIds.has(operationId) || !liveOperation || liveOperation.pluginId !== operation.pluginId || liveOperation.type !== operation.type || liveOperation.theaterId !== operation.theaterId) return;
    }
    if (operation && (!descriptor || descriptorCompanions.length === 0 || !canOpenCompanions)) {
      forceDropCompanionOperationId();
      focusMap();
      requestOperationKeyboardFocus(operationId);
      return;
    }
    setActiveOperation(operationId);
    // companion 레이어 승격은 대상을 최소화 목록에서 꺼낸다(setFocusLayer) — 캔버스 복원과 다른
    // 경로일 뿐 사용자에게는 같은 "패널 열기"다. 그러므로 같은 자동 재개를 받는다.
    setCompanionOperationId(operationId);
    requestOperationKeyboardFocus(operationId);
    if (operationWasMinimized) resumeIfDormant(operationId);
    return;
  }
  // 전체 칸이 서 있는 동안의 포커스 이동은 그 칸을 새 패널에게 넘긴다 — 있던 패널은 자기가 기억한
  // 자리로 돌아가 감춰진다(스토어가 밀려난 패널만 되돌리므로, 각 패널의 복원 메모는 서로 덮이지 않는다).
  // 앉힐 수 없으면(아레나 미측정) 승계를 접고 아래 일반 경로로 내려간다.
  if (getSnapFullOperationId() !== null && !getAlignAll()) {
    const wasMinimized = getCanvasSnapshot().minimized.includes(operationId);
    setActiveOperation(operationId);
    if (snapOperationToFullZone(operationId, commitSnappedGeometry)) {
      requestOperationKeyboardFocus(operationId);
      if (wasMinimized) resumeIfDormant(operationId);
      return;
    }
  }
  focusMap();
  requestOperationKeyboardFocus(operationId);
}

// 스냅 기하의 durable 쓰기 — 캔버스의 드래그 커밋과 같은 경로다. 기하는 patchOperation의 클라이언트
// 입력이 아니라 서버가 받는 geometry 필드이므로 여기서 직접 PATCH한다. 진입구가 여럿(키보드 스냅·
// Alt↑·포커스 승계·플러그인 focus)이라 한 곳에 모아, 스냅 funnel(applySnapZone)에 이 쓰기를 넘긴다 —
// funnel이 들어가는 패널과 전체 칸에서 밀려난 패널을 모두 이 경로로 적는다.
function commitSnappedGeometry(operationId: string): void {
  const geometry = getCanvasSnapshot().operations[operationId];
  if (!geometry) return;
  void fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geometry }),
  }).catch(() => undefined);
}

// Snap 전체 이동 — 플러그인의 focus(id, { snap: "full" })가 여기로 온다. 캡션 ⤢·Alt↑와 같은 진입구
// (snapOperationToFullZone)를 쓰고, 앉힐 수 없는 모드·화면(War Room 선별·Theater 미로드·아레나
// 없음)에서는 false를 돌려 일반 이동(routeOperationFocus)으로 폴백한다. Fleet Map 저줌은 막지 않는다 —
// 스냅이 줌을 100%로 되돌리므로 결과는 언제나 작업 크기의 한 칸이다(드래그 스냅의 저줌 금지는 별개).
// companion은 대상 Theater(로드된 Theater)의 것만 정리한다 — 이어받으면 「기존 전체화면이 아님」을 어긴다.
// 모두 정렬 중에는 묶음을 깨지 않고 활성화만 한다 — 칸 이동은 드롭·토글이 소유한다.
function trySnapFullFocus(operationId: string, resumeIfDormant: (operationId: string) => void): boolean {
  if (isTriageActive()) return false;
  const snapshot = getState();
  const operation = snapshot.operations.find((candidate) => candidate.id === operationId);
  if (!operation || operation.theaterId !== snapshot.activeTheaterId || getLoadedTheaterId() !== operation.theaterId) return false;
  if (getAlignAll()) {
    const wasMinimized = getCanvasSnapshot().minimized.includes(operationId);
    if (wasMinimized) playRestoreFlight(operationId);
    restoreOperation(operationId);
    setActiveOperation(operationId);
    requestOperationKeyboardFocus(operationId);
    if (wasMinimized) resumeIfDormant(operationId);
    return true;
  }
  if (!getCanvasSnapArenaRect()) return false;
  // companion 레이어가 전체 칸 위에 열려 있었다면 닫는 것으로 끝내지 않고, 이 패널이 그 칸을 받는다.
  if (getCompanionOperationId() !== null) forceDropCompanionOperationId();
  const wasMinimized = getCanvasSnapshot().minimized.includes(operationId);
  if (wasMinimized) playRestoreFlight(operationId);
  if (!snapOperationToFullZone(operationId, commitSnappedGeometry)) return false;
  setActiveOperation(operationId);
  requestOperationKeyboardFocus(operationId);
  if (wasMinimized) resumeIfDormant(operationId);
  return true;
}

function settleReorderPatches(patches: readonly Promise<unknown>[]): Promise<void> {
  return Promise.allSettled(patches).then((results) => {
    if (results.some((result) => result.status === "rejected")) throw new Error("reorder_partial_failure");
  });
}

// 거절 에러에 붙어 온 "줄여야 할 글자 수". 플러그인의 에러 클래스를 import하면 core가 플러그인
// 구현에 의존하게 되므로 구조로만 읽고, 없거나 모양이 다르면 그냥 없는 것으로 둔다.
function readShortenByChars(error: unknown): number | null {
  if (!(error instanceof Error) || !("shortenByChars" in error)) return null;
  const value = (error as { readonly shortenByChars?: unknown }).shortenByChars;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sortedTheaterOperations(state: ConsoleState): readonly OperationNode[] {
  const operations = state.operations.filter((operation) => operation.theaterId === state.activeTheaterId);
  return sortOperationsByOrder(operations, operationOrderFromNodes(operations));
}

// 포커스·발사 중앙의 기준 창은 아레나다 — 전면 스테이지 rect를 그대로 쓰면 대상이
// 부유 크롬 밑 중앙에 앉는다. 스토어의 인셋을 발화 시점에 읽어 같은 원천을 공유한다.
function viewportSizeFor(element: HTMLElement | null): { readonly width: number; readonly height: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const insets = getCanvasArenaInsets();
  return {
    width: Math.max(0, rect.width - insets.left - insets.right),
    height: Math.max(0, rect.height - insets.top - insets.bottom),
  };
}

function ensurePluginGeometry(operation: OperationNode): OperationGeometry {
  return operation.geometry ?? { x: 0, y: 0, width: DEFAULT_SHELL_WIDTH, height: DEFAULT_SHELL_HEIGHT, zIndex: 0 };
}

function canvasCenterPoint(element: HTMLElement | null): CanvasPoint {
  const snapshot = getCanvasSnapshot();
  const insets = getCanvasArenaInsets();
  const width = Math.max(0, (element?.clientWidth ?? 800) - insets.left - insets.right);
  const height = Math.max(0, (element?.clientHeight ?? 600) - insets.top - insets.bottom);
  // 저장 viewport는 아레나-상대 좌표이므로 아레나-local 중앙점을 그대로 환산하면 된다.
  return screenToCanvas({ x: width / 2, y: height / 2 }, snapshot.viewport);
}

function canvasPointToGeometry(point: CanvasPoint): Omit<OperationGeometry, "zIndex"> {
  return {
    x: point.x - DEFAULT_SHELL_WIDTH / 2,
    y: point.y - DEFAULT_SHELL_HEIGHT / 2,
    width: DEFAULT_SHELL_WIDTH,
    height: DEFAULT_SHELL_HEIGHT,
  };
}

async function launchViaPlugin(
  pluginId: string | null,
  kind: OperationLaunchKind,
  geometry: OperationGeometry,
  theaterId: string,
  plugins: readonly ClientExecutionProvider[],
  variant?: Readonly<Record<string, string>>,
): Promise<void> {
  await createLaunchedOperation(pluginId, kind, geometry, theaterId, plugins, variant);
}

async function createLaunchedOperation(
  pluginId: string | null,
  kind: OperationLaunchKind,
  geometry: OperationGeometry,
  theaterId: string,
  plugins: readonly ClientExecutionProvider[],
  variant?: Readonly<Record<string, string>>,
): Promise<void> {
  const plugin = plugins.find((p) => p.id === pluginId);
  const resync = () => { void fetchOperations(null).then(hydrateOperations).catch(() => {}); };
  const capabilities = createHostCapabilities(resync);
  let newOperationId: string | null = null;
  if (plugin?.launch) {
    const result = await plugin.launch({ theaterId, kind, geometry, operations: capabilities.operations, variant });
    newOperationId = result.id;
  } else {
    const operation = await capabilities.operations.create({
      theaterId,
      type: kind.type,
      pluginId,
      title: kind.title,
      geometry,
    });
    newOperationId = operation.id;
  }
  await fetchOperations(null).then(hydrateOperations).catch(() => {});
  if (!newOperationId) return;
  // 플러그인 persist와 별개로 생성 좌표를 그 Theater 캔버스에 먼저 심는다. hydrate 뒤
  // ensureDefaultGeometry가 cascade(index×40)로 덮는 창을 없애기 위함이다.
  setTheaterOperationGeometry(theaterId, newOperationId, geometry);
  // 전체 한 칸이 서 있는 상태에서 새 Operation을 만들면 그 칸을 새 패널이 이어받는다 — handleFocus·
  // Alt+←/→ 순환과 같은 승계 정책이다(있던 패널은 자기가 기억한 자리로 돌아가 감춰진다).
  //
  // 단, 비동기 launch 동안 사용자가 다른 Theater로 전환했을 수 있다. 스냅 유지는 canvas 스토어가 로드한
  // Theater 기준이므로, 그 로드된 Theater가 launch 시점 Theater와 같을 때만 승계해야 한다. 다르면 타 Theater
  // 소속 op를 이 Theater의 칸에 앉혀 패널 상태를 망가뜨린다.
  // store.activeTheaterId가 아니라 getLoadedTheaterId()를 보는 이유: loadForTheater가 passive effect라 store보다 늦게
  // 갱신되어, A→B→A 왕복 시 store는 A인데 canvas는 아직 B인 desync 창이 생기기 때문이다.
  const stillOnLaunchTheater = getLoadedTheaterId() === theaterId;
  // fetchOperations 실패(.catch)로 hydrate가 누락되면 store에 newOperationId가 없다. 이때 승계하면
  // 존재하지 않는 포커스 대상을 가리켜 빈 화면이 박제된다.
  // hydrate된 경우에만 승계하고, 아니면 focusOperation(op 부재 시 안전하게 no-op)으로 기존 전체 칸을 그대로 둔다.
  const operationHydrated = getState().operations.some((operation) => operation.id === newOperationId);
  // Analyze는 명시적인 사용자 focus만 따라간다. 새 Operation 생성은 열린 분석 대상을 승계하지 않는다.
  if (isTriageActive()) {
    pickTriageOperation(newOperationId);
    return;
  }
  if (getTheaterCompanionOperationId(theaterId) !== null) return;
  if (stillOnLaunchTheater && operationHydrated && getSnapFullOperationId() !== null && snapOperationToFullZone(newOperationId, commitSnappedGeometry)) {
    setActiveOperation(newOperationId);
  } else {
    // Theater가 다르거나 hydrate 누락이면 Theater-aware한 focusOperation으로 처리한다(launch Theater로 복귀·포커스, 부재 시 no-op).
    focusOperation(newOperationId);
  }
}
