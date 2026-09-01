import { pluginRuntimeState } from "../operation-activity.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n/index.js";

import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import type { ClientApiCapability, FleetClientPlugin, OperationKindDescriptor } from "@fleet-console/sdk/plugin";

import { ApiError, createGroup, deleteGroup, fetchGroups, fetchOperations, fetchTheaters, patchOperation, patchTheaterOrder, renameOperation, updateGroup, type DeferredDeletionReceipt } from "../api.js";
import { clearActiveOperation, shouldReleaseActiveOperation } from "../active-operation-surface.js";
import { availableCompanionPanels, blocksOperationsShortcutWhileEditing, isBlockingDialogOpen, resolveCompanionShortcutToggle, resolveOperationsArrowShortcutAction, usableCompanionShortcuts } from "../shortcuts.js";
import { closeOperationCompletely, minimizeOperationCompletely, resumeOperationInPlace } from "../operation-actions.js";
import { forgetTheaterCompletely, registerTheaterFromPath } from "../theater.js";
import { claimTopZIndex, clearCompanionOperationId, clearMaximizedOperationId, consumePendingFitAllOperations, ensureDefaultGeometry, fitAllOperations, focusOperation as focusCanvasOperation, forceDropCompanionOperationId, getCanvasArenaInsets, getCompanionOperationId, getCompanionPanelVisibilityOverrides, getFocusLayerRevision, getFormationView, getLoadedTheaterId, getMaximizedOperationId, getSnapshot as getCanvasSnapshot, getTheaterCanvasSnapshot, getTheaterCompanionOperationId, loadForTheater, minimizeOperations, pruneOperations, resolveLaunchGeometry, restoreOperation, setCanvasArenaInsets, setCompanionOperationId, setCompanionPanelVisible, setMaximizedOperationId, setOperationGeometry, setTheaterOperationGeometry, toggleFormationView, useCompanionOperationId, useFormationView, useMaximizedOperationId, useMinimized, type CanvasArenaInsets, type OperationGeometry } from "../canvas/canvas-store.js";
import { screenToCanvas, type CanvasPoint } from "../canvas/coordinates.js";
import { playRestoreFlight } from "../canvas/panel-motion.js";
import { OperationsCanvas } from "../canvas/canvas.js";
import { GroupContextMenu } from "../canvas/group-context-menu.js";
import { operationAccentFromNode } from "../canvas/operation-accent.js";
import { armTriageSetAside, deferTriageOperation, disarmTriageSetAside, dismissTriageOperation, enterTriage, focusedTriageOperationId, forgetTriageOperation, getTriageSetAsideArmedId, isTriageActive, pickTriageOperation, recordTriageActivity, releaseInactiveActiveAwaitingClaim, resolveTriageQueue, restoreTriageSession, setTriageActive, useTriageActive } from "../canvas/triage-store.js";
import { createHostCapabilities } from "../plugin-capabilities.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { RailEdgeDock, SideBarEdgeDock } from "../components/panel-edge-docks.js";
import { RightRail } from "../rail/right-rail.js";
import { OperationsSideBar } from "../sidebar/operations-side-bar.js";
import { TriageSideBar } from "../sidebar/triage-side-bar.js";
import { useContextMenuKeyboard } from "../sidebar/context-menu-keyboard.js";
import { toggleSideBarStatusAxis, useSideBarState } from "../sidebar/operations-side-bar-store.js";
import { useRailOccupiedPx } from "../rail/rail-store.js";
import { ExpandedSurfaceLayer } from "../expanded-surface/layer.js";
import { useGlobalSettingsStore } from "../global-settings-store.js";
import { shouldHandleOperationsKeyboardShortcut } from "../components/keyboard-shortcuts-dialog.js";
import { cancelAddTheater, compareOperationCreatedAt, consumeOperationFocus, consumeQuickLaunch, reopenQuickLaunchWithDraft, focusCycleOperationIds, focusOperation, getState, hydrateGroups, hydrateInitialOperations, hydrateOperations, hydrateTheaters, nextOperationId, requestOperationKeyboardFocus, setActiveOperation, setActiveTheater, sortOperationsByOrder } from "../store.js";
import type { ConsoleState, OperationNode } from "../types.js";
import { MobileShell } from "../mobile/mobile-shell.js";
import { OperationBodyPool, type OperationBodyConfig } from "../mobile/operation-body-pool.js";
import { useViewMode } from "../view-mode-store.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";

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
}

export function Operations({ state, claimBootPanelMinimization, onDeferredDeletion }: OperationsProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const maximizedOperationId = useMaximizedOperationId();
  const companionOperationId = useCompanionOperationId();
  const formationView = useFormationView();
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
  } | null>(null);
  const triageActive = useTriageActive();

  // ── 아레나 인셋 ─────────────────────────────────────────────────────────────
  // 전면 캔버스 위 부유 크롬(사이드바·레일 카드)의 점유 폭. 크롬 구성의 소유자인 이 페이지가
  // 단일 원천으로 계산해 캔버스(prop)와 스토어(fit-all)에 같은 값을 심는다 — 주입구가 갈리면
  // Cruise는 인셋을 알고 Tactical은 모르는 감사 실패 양식이 재발한다.
  const sideBar = useSideBarState();
  const railOccupiedPx = useRailOccupiedPx();
  const arenaInsets: CanvasArenaInsets = useMemo(() => ({
    left: sideBar.collapsed ? 0 : sideBar.width + CHROME_FLOAT_GUTTER,
    top: 0,
    right: railOccupiedPx > 0 ? railOccupiedPx + CHROME_FLOAT_GUTTER : 0,
    bottom: 0,
  }), [railOccupiedPx, sideBar.collapsed, sideBar.width]);
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
    refreshCatalog();
    return () => { catalogRequestEpochRef.current += 1; };
  }, [refreshCatalog, state.activeTheaterId]);

  // Alt+화살표는 캔버스 배치 순서와 패널 문법을 공유하고, Alt+F/Alt+S는 같은 capture/editable 가드 정책을 따른다.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (viewMode.effective === "mobile") return;
      if (!shouldHandleOperationsKeyboardShortcut()) return;
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
      if (event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && event.code === "Digit1") {
        if (active instanceof HTMLElement && active.closest(".xterm")) return;
        if (isTriageActive()) return;
        if (!stateRef.current.operationsHydrated) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        fitAllOperations();
        return;
      }
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      // macOS의 Option+문자는 합성 문자를 내보내므로(event.key가 "©"/"ƒ") 물리 키 기준인 event.code로 판별한다.
      if (event.code === "KeyS" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleSideBarStatusAxis();
        return;
      }
      if (event.code === "KeyF" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleFormationView();
        return;
      }
      if (event.code === "KeyT" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (isTriageActive()) {
          setTriageActive(false);
        } else if (stateRef.current.theaters.length > 0) {
          enterTriage(focusedTriageOperationId(document.activeElement));
        }
        return;
      }
      if (event.shiftKey) return;
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
      const companion = usableCompanionShortcuts(activeCompanions)
        .find((candidate) => candidate.shortcut?.code === event.code);
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
        if (toggle.closeLayer) clearCompanionOperationId();
        return;
      }
      const theaterId = snapshot.activeTheaterId;
      const triageActive = isTriageActive();
      const arrowAction = resolveOperationsArrowShortcutAction(triageActive, event.code);
      if (arrowAction === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat && (arrowAction === "maximize-toggle"
        || arrowAction === "minimize"
        || arrowAction === "triage-set-aside")) return;
      if ((arrowAction === "maximize-toggle" || arrowAction === "minimize" || arrowAction === "triage-noop" || arrowAction === "triage-set-aside")
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
        canvas.operationOrder,
        canvas.collapsedGroups,
        canvas.minimized,
      );
      if (arrowAction === "maximize-toggle" || arrowAction === "minimize") {
        const operationId = snapshot.activeOperationId;
        if (!operationId || !theaterOperations.some((operation) => operation.id === operationId) || canvas.minimized.includes(operationId)) return;
        if (arrowAction === "maximize-toggle") {
          if (getMaximizedOperationId() === operationId) clearMaximizedOperationId();
          else setMaximizedOperationId(operationId);
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
      const currentId = getCompanionOperationId() ?? getMaximizedOperationId() ?? stateRef.current.activeOperationId;
      const nextId = nextOperationId(order, currentId, arrowAction === "focus-next" ? 1 : -1);
      if (!nextId) return;
      void routeOperationFocus(nextId, registry.operationKinds, STABLE_RAIL_API, focusRequestEpochRef, () => focusOperation(nextId));
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [companionOperationId, formationView, maximizedOperationId, registry.operationKinds, viewMode.effective]);

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
    for (const operation of sortedTheaterOperations(state)) ensureDefaultGeometry(operation.id, operation.geometry);
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
      getMaximizedOperationId(),
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
  }, []);

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
    // loadForTheater effect가 먼저 도착 Theater의 focus layer와 Formation underlay를 복원한다.
    void routeOperationFocus(operationId, registry.operationKinds, STABLE_RAIL_API, focusRequestEpochRef, () => focusMapOperation(operationId));
    consumeOperationFocus();
  }, [focusMapOperation, registry.operationKinds, state.activeTheaterId, state.operations, state.pendingOperationFocus, viewMode.effective]);

  const canLaunch = !!state.activeTheaterId && !state.addingTheater;
  const theaterOperations = (state.operations ?? []).filter((op) => op.theaterId === state.activeTheaterId);
  const renderKindIcon = useCallback((pluginId: string, kind: OperationLaunchKind): ReactNode => {
    const plugin = registry.plugins.find((p) => p.id === pluginId);
    return plugin?.renderLaunchIcon?.(kind) ?? null;
  }, [registry.plugins]);

  const handleCanvasLaunchKind = useCallback((
    pluginId: string,
    kind: OperationLaunchKind,
    canvasPoint: CanvasPoint,
    theaterId?: string,
    variant?: Readonly<Record<string, string>>,
  ) => {
    const launchTheaterId = theaterId ?? stateRef.current.activeTheaterId;
    if (!launchTheaterId) return;
    // Station Keeping이 켜진 Theater의 생성 좌표는 전부 정착을 거친다 — 어느 진입 경로든 같은 규율.
    const geometry = resolveLaunchGeometry(launchTheaterId, { ...canvasPointToGeometry(canvasPoint), zIndex: claimTopZIndex() });
    void launchViaPlugin(pluginId, kind, geometry, launchTheaterId, registry.plugins, variant);
  }, [registry.plugins]);

  const handleSideBarLaunchKind = useCallback((
    pluginId: string,
    kind: OperationLaunchKind,
    variant?: Readonly<Record<string, string>>,
  ) => {
    const launchTheaterId = stateRef.current.activeTheaterId;
    if (!launchTheaterId) return;
    const canvasPoint = canvasCenterPoint(bodyRef.current);
    const geometry = resolveLaunchGeometry(launchTheaterId, { ...canvasPointToGeometry(canvasPoint), zIndex: claimTopZIndex() });
    void launchViaPlugin(pluginId, kind, geometry, launchTheaterId, registry.plugins, variant);
  }, [registry.plugins]);

  const handleRailLaunchOperation = useCallback((pluginId: string, kind: OperationLaunchKind) => {
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
    void launchViaPlugin(request.pluginId, request.kind, geometry, request.theaterId, registry.plugins, request.variant)
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
  }, [registry.plugins, state.activeTheaterId, state.pendingQuickLaunch]);

  const handleLaunchAtGeometry = useCallback((pluginId: string, kind: OperationLaunchKind, geometry: OperationGeometry) => {
    const launchTheaterId = stateRef.current.activeTheaterId;
    if (!launchTheaterId) return;
    void launchViaPlugin(pluginId, kind, resolveLaunchGeometry(launchTheaterId, geometry), launchTheaterId, registry.plugins);
  }, [registry.plugins]);

  const handleFocus = useCallback((operationId: string) => {
    const operation = stateRef.current.operations.find((candidate) => candidate.id === operationId);
    if (!operation) return;
    // 선별 중에는 전 Theater가 마운트이므로 focusOperation의 Theater 전환을 타지 않고 바로 지목한다 —
    // 전환을 타면 loadForTheater가 목적지의 저장된 focus layer를 선별 위로 부활시킨다.
    if (isTriageActive()) {
      void routeOperationFocus(operationId, registry.operationKinds, STABLE_RAIL_API, focusRequestEpochRef, () => focusMapOperation(operationId));
      return;
    }
    if (operation.theaterId !== stateRef.current.activeTheaterId) {
      focusRequestEpochRef.current += 1;
      focusOperation(operationId);
      return;
    }
    void routeOperationFocus(operationId, registry.operationKinds, STABLE_RAIL_API, focusRequestEpochRef, () => focusMapOperation(operationId));
  }, [focusMapOperation, registry.operationKinds]);

  // 빈 캔버스의 일괄 열기 — 대기 전원을 복원하고 Tactical로 정렬해 스택 대신 그리드에 착지시킨다.
  // 목록 순서(updatedAt 내림차순)의 첫 항목을 활성으로 둔다. 비행 연출은 N개분이라 생략하고
  // formation 진입 전이가 그 역할을 대신한다.
  const handleOpenAll = useCallback((operationIds: readonly string[]) => {
    if (operationIds.length === 0) return;
    for (const operationId of operationIds) restoreOperation(operationId);
    setActiveOperation(operationIds[0] ?? null);
    if (!getFormationView()) toggleFormationView();
  }, []);

  const handleMinimize = useCallback((operationId: string) => {
    minimizeOperationCompletely(operationId);
  }, []);

  const handleResume = useCallback((operationId: string) => {
    const operation = stateRef.current.operations.find((candidate) => candidate.id === operationId);
    if (!operation) return;
    const resume = () => resumeOperationInPlace(operationId, stateRef.current.operations, registry.plugins, handleFocus);
    if (operation.theaterId !== stateRef.current.activeTheaterId) {
      resumeBootProtectionRef.current = { theaterId: operation.theaterId, operationId };
      setActiveTheater(operation.theaterId);
      resume();
      return;
    }
    resume();
  }, [handleFocus, registry.plugins]);

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

  const openOperationMenu = useCallback((operationId: string, anchor: DOMRect, returnFocus?: HTMLElement | null) => {
    if (!stateRef.current.operations.some((operation) => operation.id === operationId)) return;
    setOperationMenu({ operationId, anchor, returnFocus });
  }, []);
  // 포커스 복귀는 갱신 함수 밖에서 한다 — setState updater는 순수해야 하고, StrictMode의
  // 이중 호출에서 focus()가 두 번 실행된다.
  const closeOperationMenu = useCallback(() => {
    operationMenuReturnFocusRef.current?.focus();
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
    const plugin = (pluginId ? registry.plugins.find((p) => p.id === pluginId) : null) ?? null;
    void closeOperationCompletely(operationId, plugin)
      .then((deletion) => {
        forgetTriageOperation(operationId);
        onDeferredDeletion(deletion);
      })
      .finally(() => closingOperationIds.delete(operationId));
  }, [onDeferredDeletion, registry.plugins]);

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
      {triageActive ? (
        <TriageSideBar
          theaters={state.theaters}
          operations={state.operations}
          operationRuntime={state.operationRuntime}
          operationNotifications={state.operationNotifications}
          catalog={catalog}
          plugins={registry.plugins}
          renderKindIcon={renderKindIcon}
          canLaunch={canLaunch}
          onLaunchKind={handleSideBarLaunchKind}
          onPick={pickTriageOperation}
          onClose={handleClose}
          onRename={handleRename}
          onOpenOperationMenu={openOperationMenu}
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
      <div className="operations-center-stage" ref={bodyRef}>
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
          onDismissOperationMenu={dismissOperationMenu}
        />
      </div>
      <RightRail theaterId={state.activeTheaterId} api={STABLE_RAIL_API} onLaunchOperation={handleRailLaunchOperation} />
      {/* 접힌 패널의 문 — 각 카드가 소멸한 자리의 엣지에 서고, 두 사이드바(Map·War Room)가
          같은 접힘 상태를 쓰므로 독도 모드와 무관하게 이 페이지가 한 번만 세운다. */}
      <SideBarEdgeDock />
      <RailEdgeDock />
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
      operations={triageActive ? state.operations : theaterOperations}
      operationKinds={registry.operationKinds}
      capabilities={poolCapabilities}
      defaultConfig={defaultBodyConfig}
    >
      {shell}
    </OperationBodyPool>
  );
}

// 모든 사용자 포커스 진입점은 현재 로드된 Theater의 live 표시 상태만으로 같은 순서를 적용한다.
async function routeOperationFocus(operationId: string, operationKinds: readonly OperationKindDescriptor[], api: ClientApiCapability, requestEpochRef: { current: number }, focusMap: () => void): Promise<void> {
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
      if (getFormationView()) {
        if (getCanvasSnapshot().minimized.includes(operationId)) playRestoreFlight(operationId);
        restoreOperation(operationId);
        setActiveOperation(operationId);
        requestOperationKeyboardFocus(operationId);
        return;
      }
      focusMap();
      requestOperationKeyboardFocus(operationId);
      return;
    }
    setActiveOperation(operationId);
    setCompanionOperationId(operationId);
    requestOperationKeyboardFocus(operationId);
    return;
  }
  if (getMaximizedOperationId() !== null) {
    setActiveOperation(operationId);
    setMaximizedOperationId(operationId);
    requestOperationKeyboardFocus(operationId);
    return;
  }
  if (getFormationView()) {
    if (getCanvasSnapshot().minimized.includes(operationId)) playRestoreFlight(operationId);
    restoreOperation(operationId);
    setActiveOperation(operationId);
    requestOperationKeyboardFocus(operationId);
    return;
  }
  focusMap();
  requestOperationKeyboardFocus(operationId);
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
  return state.operations
    .filter((operation) => operation.theaterId === state.activeTheaterId)
    .sort(compareOperationCreatedAt);
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
  pluginId: string,
  kind: OperationLaunchKind,
  geometry: OperationGeometry,
  theaterId: string,
  plugins: readonly FleetClientPlugin[],
  variant?: Readonly<Record<string, string>>,
): Promise<void> {
  await createLaunchedOperation(pluginId, kind, geometry, theaterId, plugins, variant);
}

async function createLaunchedOperation(
  pluginId: string,
  kind: OperationLaunchKind,
  geometry: OperationGeometry,
  theaterId: string,
  plugins: readonly FleetClientPlugin[],
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
  // 최대화 패널이 떠 있는 상태에서 새 Operation을 만들면 최대화를 유지하고 새 패널을 최대화 대상으로 승계한다.
  // focusOperation은 pendingOperationFocus 경로로 clearMaximizedOperationId를 부르므로(최대화 해제), 최대화 중에는 호출하지 않는다.
  // handleFocus(operations.tsx)·Alt+←/→ 순환과 동일 정책으로, 새 패널로 렌더 전용 포커스 레이어를 승계한다.
  //
  // 단, 비동기 launch 동안 사용자가 다른 Theater로 전환했을 수 있다. getMaximizedOperationId/setMaximizedOperationId는
  // canvas 스토어가 로드한 Theater 기준으로 동작하므로, 그 로드된 Theater가 launch 시점 Theater와 같을 때만 승계해야 한다.
  // 다르면 setMaximizedOperationId가 다른 Theater에 타 Theater 소속 op를 최대화 대상으로 잘못 등록해 패널 상태를 망가뜨린다.
  // store.activeTheaterId가 아니라 getLoadedTheaterId()를 보는 이유: loadForTheater가 passive effect라 store보다 늦게
  // 갱신되어, A→B→A 왕복 시 store는 A인데 canvas는 아직 B인 desync 창이 생기기 때문이다.
  const stillOnLaunchTheater = getLoadedTheaterId() === theaterId;
  // fetchOperations 실패(.catch)로 hydrate가 누락되면 store에 newOperationId가 없다. 이때 승계하면
  // 존재하지 않는 포커스 대상을 가리켜 빈 화면이 박제된다.
  // hydrate된 경우에만 승계하고, 아니면 focusOperation(op 부재 시 안전하게 no-op)으로 기존 최대화 패널을 그대로 둔다.
  const operationHydrated = getState().operations.some((operation) => operation.id === newOperationId);
  // Analyze는 명시적인 사용자 focus만 따라간다. 새 Operation 생성은 열린 분석 대상을 승계하지 않는다.
  if (isTriageActive()) {
    pickTriageOperation(newOperationId);
    return;
  }
  if (getTheaterCompanionOperationId(theaterId) !== null) return;
  if (stillOnLaunchTheater && operationHydrated && getMaximizedOperationId() !== null) {
    setActiveOperation(newOperationId);
    setMaximizedOperationId(newOperationId);
  } else {
    // Theater가 다르거나 hydrate 누락이면 Theater-aware한 focusOperation으로 처리한다(launch Theater로 복귀·포커스, 부재 시 no-op).
    focusOperation(newOperationId);
  }
}
