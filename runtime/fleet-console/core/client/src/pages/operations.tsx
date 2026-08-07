import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import type { ClientApiCapability, FleetClientPlugin, OperationKindDescriptor } from "@fleet-console/sdk/plugin";

import { addTheater, createGroup, deleteGroup, fetchGroups, fetchOperations, fetchTheaters, issueTheaterFolderGrant, patchOperation, patchTheaterOrder, renameOperation, updateGroup, ApiError, type DeferredDeletionReceipt } from "../api.js";
import { isBlockingDialogOpen } from "../focus-guards.js";
import { closeOperationCompletely } from "../operation-close.js";
import { forgetTheaterCompletely } from "../theater-forget.js";
import { claimTopZIndex, clearCompanionOperationId, clearMaximizedOperationId, consumePendingFitAllOperations, ensureDefaultGeometry, fitAllOperations, focusOperation as focusCanvasOperation, forceDropCompanionOperationId, getCompanionOperationId, getCompanionPanelVisibilityOverrides, getFocusLayerRevision, getFormationView, getLoadedTheaterId, getMaximizedOperationId, getSnapshot as getCanvasSnapshot, getTheaterCanvasSnapshot, getTheaterCompanionOperationId, loadForTheater, minimizeOperation, minimizeOperations, pruneOperations, resolveLaunchGeometry, restoreOperation, setCompanionOperationId, setCompanionPanelVisible, setMaximizedOperationId, setOperationGeometry, toggleFormationView, useCompanionOperationId, useFormationView, useMaximizedOperationId, useMinimized, type OperationGeometry } from "../canvas/canvas-store.js";
import { screenToCanvas, type CanvasPoint } from "../canvas/coordinates.js";
import { playMinimizeFlight, playRestoreFlight } from "../canvas/panel-motion.js";
import { OperationsCanvas } from "../canvas/canvas.js";
import { GroupContextMenu } from "../canvas/group-context-menu.js";
import { operationAccentFromNode } from "../canvas/operation-accent.js";
import { armTriageSetAside, deferTriageOperation, disarmTriageSetAside, dismissTriageOperation, enterTriage, focusedTriageOperationId, forgetTriageOperation, getTriageSetAsideArmedId, isTriageActive, pickTriageOperation, recordTriageActivity, resolveTriageQueue, setTriageActive, useTriageActive } from "../canvas/triage-store.js";
import { createHostCapabilities } from "../plugin-capabilities.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { RightRail } from "../rail/right-rail.js";
import { OperationsSideBar } from "../sidebar/operations-side-bar.js";
import { TriageSideBar } from "../sidebar/triage-side-bar.js";
import { useContextMenuKeyboard } from "../sidebar/context-menu-keyboard.js";
import { toggleSideBarStatusAxis } from "../sidebar/operations-side-bar-store.js";
import { CodexReadingSheet } from "../components/codex-reading-sheet.js";
import { useGlobalSettingsStore } from "../global-settings-store.js";
import { shouldHandleOperationsKeyboardShortcut } from "../components/keyboard-shortcuts-dialog.js";
import { availableCompanionPanels, resolveCompanionShortcutToggle, usableCompanionShortcuts } from "../companion-shortcut.js";
import { resolveOperationsArrowShortcutAction } from "../operations-arrow-shortcut.js";
import { beginAddTheater, cancelAddTheater, compareOperationCreatedAt, completeAddTheater, consumeOperationFocus, failAddTheater, focusCycleOperationIds, focusOperation, getState, hydrateGroups, hydrateOperations, hydrateTheaters, nextOperationId, requestOperationKeyboardFocus, setActiveOperation, setActiveTheater, sortOperationsByOrder } from "../store.js";
import type { ConsoleState, OperationNode } from "../types.js";
import { MobileShell } from "../mobile/mobile-shell.js";
import { OperationBodyPool, type OperationBodyConfig } from "../mobile/operation-body-pool.js";
import { useViewMode } from "../view-mode-store.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";

const STABLE_RAIL_API: ClientApiCapability = createHostCapabilities().api;
const DEFAULT_SHELL_WIDTH = 560;
const DEFAULT_SHELL_HEIGHT = 360;
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
  const [catalog, setCatalog] = useState<readonly OperationCatalogPlugin[]>([]);
  const [triageOperationMenu, setTriageOperationMenu] = useState<{
    readonly operationId: string;
    readonly anchor: DOMRect;
    readonly returnFocus?: HTMLElement | null;
  } | null>(null);
  const triageActive = useTriageActive();

  const operationOrder = useMemo(
    () => sortedTheaterOperations(state).map((operation) => operation.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.operations, state.activeTheaterId],
  );
  const stateRef = useRef(state);
  const triageMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  const focusRequestEpochRef = useRef(0);
  const catalogRequestEpochRef = useRef(0);
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
    recordTriageActivity(state.operations, state.operationStatus);
  }, [state.operationStatus, state.operations]);

  useEffect(() => {
    if (!triageActive) setTriageOperationMenu(null);
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
      if (active instanceof HTMLElement && active.matches("input, textarea, [contenteditable='true']") && !active.closest(".xterm")) return;
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
        const queue = resolveTriageQueue(snapshot.operations, snapshot.operationStatus);
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
        playMinimizeFlight(operationId);
        minimizeOperation(operationId);
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

  useEffect(() => {
    if (viewMode.effective === "mobile") return;
    for (const operationId of operationOrder) ensureDefaultGeometry(operationId);
    if (!state.operationsHydrated) return;
    pruneOperations(operationOrder);
    // 각 Theater를 세션 중 처음 열 때 한 번, 그 Theater의 부팅 시점 기존 패널을 최소화한다.
    // (App boot 활성 Theater뿐 아니라 선택·전환으로 처음 진입하는 Theater도 포함 — Map을 항상 깨끗하게 연다.)
    // 이후 생성·route 재진입·같은 세션 재진입은 대상에서 빠져, 사용자의 restore를 보존한다.
    if (!state.activeTheaterId) return;
    const bootOperationIds = claimBootPanelMinimization(state.activeTheaterId);
    if (bootOperationIds === null) return;
    // 선택으로 진입한 경우(pendingOperationFocus) 그 패널은 최소화에서 제외해 곧바로 표면화한다 — 선택한 패널만 하나씩 노출.
    const protectedIds = new Set([
      stateRef.current.pendingOperationFocus,
      getCompanionOperationId(),
      getMaximizedOperationId(),
    ].filter((id): id is string => id !== null));
    minimizeOperations(bootOperationIds.filter((id) => !protectedIds.has(id)));
  }, [claimBootPanelMinimization, operationOrder, state.activeTheaterId, state.operationsHydrated, viewMode.effective]);

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

  const handleMinimize = useCallback((operationId: string) => {
    if (stateRef.current.activeOperationId === operationId) setActiveOperation(null);
    playMinimizeFlight(operationId);
    minimizeOperation(operationId);
  }, []);

  const handleSetAccent = useCallback((operationId: string, accentKey: string | null) => {
    void patchOperation(operationId, { accent: accentKey })
      .then(() => fetchOperations(null))
      .then(hydrateOperations)
      .catch(() => {});
  }, []);

  const handleRename = useCallback((operationId: string, title: string) => {
    void renameOperation(operationId, title)
      .then(() => fetchOperations(null))
      .then(hydrateOperations)
      .catch(() => {});
  }, []);

  const handleSetGroupId = useCallback((operationId: string, groupId: string | null) => {
    void patchOperation(operationId, { groupId })
      .then(() => fetchOperations(null))
      .then(hydrateOperations)
      .catch(() => {});
  }, []);

  const handleCreateGroup = useCallback((theaterId: string, name: string, operationId?: string) => {
    void createGroup({ theaterId, name, color: "blue" })
      .then((group) => operationId ? patchOperation(operationId, { groupId: group.id }).then(() => {}) : undefined)
      .then(() => Promise.all([
        fetchOperations(null).then(hydrateOperations),
        fetchGroups(null).then(hydrateGroups),
      ]))
      .catch(() => {});
  }, []);

  const openTriageOperationMenu = useCallback((operationId: string, anchor: DOMRect, returnFocus?: HTMLElement | null) => {
    if (!stateRef.current.operations.some((operation) => operation.id === operationId)) return;
    setTriageOperationMenu({ operationId, anchor, returnFocus });
  }, []);
  // 포커스 복귀는 갱신 함수 밖에서 한다 — setState updater는 순수해야 하고, StrictMode의
  // 이중 호출에서 focus()가 두 번 실행된다.
  const closeTriageOperationMenu = useCallback(() => {
    triageMenuReturnFocusRef.current?.focus();
    setTriageOperationMenu(null);
  }, []);
  const triageContextMenuOperation = triageOperationMenu
    ? state.operations.find((operation) => operation.id === triageOperationMenu.operationId) ?? null
    : null;
  triageMenuReturnFocusRef.current = triageOperationMenu?.returnFocus ?? null;
  useContextMenuKeyboard({
    open: triageActive && triageContextMenuOperation !== null,
    menuSelector: '.group-context-menu-card[role="menu"]',
    returnFocusRef: triageMenuReturnFocusRef,
    onEscape: closeTriageOperationMenu,
  });

  const handleSetGroupColor = useCallback((groupId: string, color: string | null) => {
    if (!color) return;
    void updateGroup(groupId, { color })
      .then(() => fetchGroups(null))
      .then(hydrateGroups)
      .catch(() => {});
  }, []);

  const handleRenameGroup = useCallback((groupId: string, name: string) => {
    void updateGroup(groupId, { name })
      .then(() => fetchGroups(null))
      .then(hydrateGroups)
      .catch(() => {});
  }, []);

  const handleReorderGroups = useCallback((orderedGroupIds: readonly string[]) => {
    const groupById = new Map(stateRef.current.groups.map((group) => [group.id, group]));
    const patches = orderedGroupIds.flatMap((groupId, order) => {
      const group = groupById.get(groupId);
      if (!group || group.order === order) return [];
      return [updateGroup(groupId, { order })];
    });
    if (patches.length === 0) return;
    // 일부 PATCH가 실패해도 항상 서버 실제 순서로 재동기화한다 — Promise.all은 첫 실패에서 reject되어
    // refetch를 건너뛰므로, 성공/실패가 섞이면 낙관적 순서가 서버와 어긋난 채 UI에 남는다.
    void Promise.allSettled(patches)
      .then(() => fetchGroups(null))
      .then(hydrateGroups)
      .catch(() => {});
  }, []);

  const handleReorderTheaters = useCallback((orderedTheaterIds: readonly string[]) => {
    const theaterById = new Map(stateRef.current.theaters.map((theater) => [theater.id, theater]));
    const patches = orderedTheaterIds.flatMap((theaterId, order) => {
      const theater = theaterById.get(theaterId);
      if (!theater || theater.order === order) return [];
      return [patchTheaterOrder(theaterId, order)];
    });
    if (patches.length === 0) return;
    void Promise.allSettled(patches)
      .then(() => fetchTheaters(null))
      .then(hydrateTheaters)
      .catch(() => {});
  }, []);

  const handleUngroupAll = useCallback((groupId: string) => {
    void deleteGroup(groupId)
      .then(() => Promise.all([
        fetchOperations(null).then(hydrateOperations),
        fetchGroups(null).then(hydrateGroups),
      ]))
      .catch(() => {});
  }, []);

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
    beginAddTheater();
    try {
      const folderGrantId = await issueTheaterFolderGrant(path);
      const result = await addTheater(folderGrantId);
      completeAddTheater(result);
      // 서버 register()는 기존 order를 보존하므로, 이미 수동 정렬된 Theater를 재-오픈하면
      // completeAddTheater의 낙관적 prepend가 저장된 위치와 어긋난다(Codex P2). 서버 순서로 재수화해
      // "열어도 위치 고정" 계약을 지킨다. hydrate는 방금 활성화한 result.id 선택을 유지한다.
      void fetchTheaters(null).then(hydrateTheaters).catch(() => {});
    } catch (error) {
      failAddTheater(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleForgetTheater = useCallback(async (theaterId: string) => {
    onDeferredDeletion(await forgetTheaterCompletely(theaterId));
  }, [onDeferredDeletion]);

  const shell = viewMode.effective === "mobile" ? (
    <MobileShell
      operations={theaterOperations}
      activeOperationId={state.activeOperationId}
      operationStatus={state.operationStatus}
      operationNotifications={state.operationNotifications}
      theme={state.activeTheme}
      language={language}
      onSelectOperation={setActiveOperation}
      onCloseOperation={handleClose}
    />
  ) : (
    <div className="console-body is-canvas">
      {triageActive ? (
        <TriageSideBar
          theaters={state.theaters}
          operations={state.operations}
          operationStatus={state.operationStatus}
          operationNotifications={state.operationNotifications}
          catalog={catalog}
          plugins={registry.plugins}
          renderKindIcon={renderKindIcon}
          canLaunch={canLaunch}
          activeTheaterLabel={state.theaters.find((theater) => theater.id === state.activeTheaterId)?.label}
          onLaunchKind={handleSideBarLaunchKind}
          onPick={pickTriageOperation}
          onClose={handleClose}
          onRename={handleRename}
          onOpenOperationMenu={openTriageOperationMenu}
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
          catalog={catalog}
          canLaunch={canLaunch}
          renderKindIcon={renderKindIcon}
          onLaunchKind={handleCanvasLaunchKind}
          onLaunchAtGeometry={handleLaunchAtGeometry}
          onRefreshCatalog={refreshCatalog}
          onClose={handleClose}
          onFocus={handleFocus}
          onRename={handleRename}
          onSetAccent={handleSetAccent}
          onOpenOperationMenu={openTriageOperationMenu}
        />
      </div>
      <RightRail theaterId={state.activeTheaterId} api={STABLE_RAIL_API} />
      {triageActive && triageOperationMenu && triageContextMenuOperation ? (
        <GroupContextMenu
          kind="chip"
          operation={triageContextMenuOperation}
          groups={state.groups.filter((group) => group.theaterId === triageContextMenuOperation.theaterId)}
          accentKey={getTheaterCanvasSnapshot(triageContextMenuOperation.theaterId).operationAccent[triageContextMenuOperation.id]
            ?? operationAccentFromNode(triageContextMenuOperation)}
          anchor={triageOperationMenu.anchor}
          actions={{
            onSetAccent: (key) => handleSetAccent(triageContextMenuOperation.id, key),
            onSetGroupId: (groupId) => handleSetGroupId(triageContextMenuOperation.id, groupId),
            onCreateGroup: (name) => handleCreateGroup(triageContextMenuOperation.theaterId, name, triageContextMenuOperation.id),
          }}
          onClose={closeTriageOperationMenu}
        />
      ) : null}
      <CodexReadingSheet />
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

function sortedTheaterOperations(state: ConsoleState): readonly OperationNode[] {
  return state.operations
    .filter((operation) => operation.theaterId === state.activeTheaterId)
    .sort(compareOperationCreatedAt);
}

function viewportSizeFor(element: HTMLElement | null): { readonly width: number; readonly height: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function ensurePluginGeometry(operation: OperationNode): OperationGeometry {
  return operation.geometry ?? { x: 0, y: 0, width: DEFAULT_SHELL_WIDTH, height: DEFAULT_SHELL_HEIGHT, zIndex: 0 };
}

function canvasCenterPoint(element: HTMLElement | null): CanvasPoint {
  const snapshot = getCanvasSnapshot();
  const width = element?.clientWidth ?? 800;
  const height = element?.clientHeight ?? 600;
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
