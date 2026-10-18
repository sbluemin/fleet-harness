import { getViewedTheaterId, useViewedTheaterId } from "../../../core/client/src/integration/viewed-theater.js";
import { useHostCapabilities } from "../../../core/client/src/integration/use-host-capabilities.js";
import { pluginRuntimeState } from "../../execution/client/operation-activity.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { ClientApiCapability, ClientExecutionProvider } from "@fleet-console/sdk/plugin";

import { ApiError, createGroup, deleteGroup, fetchGroups, fetchOperations, fetchTheaters, patchOperation, patchTheaterAlias, patchTheaterOrder, renameOperation, updateGroup, type DeferredDeletionReceipt } from "../../../core/client/src/integration/api.js";
import { clearActiveOperation, shouldReleaseActiveOperation } from "../../../core/client/src/integration/active-operation-surface.js";
import { blocksOperationsShortcutWhileEditing, isBlockingDialogOpen, resolveOperationsArrowShortcutAction } from "../../../core/client/src/integration/shortcuts.js";
import { archiveOperationFromUi, resumeDormantOnOpen, resumeOperationInPlace, type ArchiveOutcome } from "../../../core/client/src/integration/operation-actions.js";
import { forgetTheaterCompletely, registerTheaterFromPath } from "./theater.js";
import { GroupContextMenu, type GroupContextMenuAlign } from "./sidebar/group-context-menu.js";
import { operationAccentFromNode } from "./operation-accent.js";
import { getTheaterGroupCollapse, pruneOperationAccents } from "./sidebar/group-collapse-store.js";
import { createHostCapabilities } from "../../../core/client/src/integration/plugin-capabilities.js";
import { usePluginRegistry } from "../../../core/client/src/integration/plugin-registry.js";
import { RightRail, useRailPanelContext } from "../../../core/client/src/chrome/rail/right-rail.js";
import { OperationsSideBar } from "./sidebar/operations-side-bar.js";
import { useSideBarFollowedInset } from "./sidebar/side-bar-motion.js";
import { useContextMenuKeyboard } from "./sidebar/context-menu-keyboard.js";
import { sideBarOccupiedWidth, toggleSideBarStatusAxis, useSideBarState } from "./sidebar/operations-side-bar-store.js";
import { useRailSettledPx } from "../../../core/client/src/chrome/rail/rail-store.js";
import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { shouldHandleOperationsKeyboardShortcut } from "../../../core/client/src/chrome/components/keyboard-shortcuts-dialog.js";
import { isShortcutRecording, matchesShortcutCommand } from "../../../core/client/src/integration/shortcut-bindings.js";
import { cancelAddTheater, consumeOperationFocus, consumeLaunch, rejectNewSession, focusCycleOperationIds, focusOperation, getState, hydrateGroups, hydrateOperations, hydrateTheaters, nextOperationId, operationOrderFromNodes, requestOperationKeyboardFocus, revealOperationStage, setActiveOperation } from "../../../core/client/src/integration/store.js";
import type { ConsoleState, OperationGeometry, OperationNode } from "../../../core/client/src/integration/types.js";
import { MobileShell } from "../../../core/client/src/chrome/mobile/mobile-shell.js";
import { setMobileDestination, takeMobileConversationDestination } from "../../../core/client/src/chrome/mobile/mobile-store.js";
import { OperationBodyPool, type OperationBodyConfig } from "../../../core/client/src/chrome/mobile/operation-body-pool.js";
import { getViewModeSnapshot, useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import { resolveConsoleLanguage } from "../../updates/client/whatsnew-i18n.js";
import { CONVERSATION_RESERVED_ARENA_WIDTH, ConversationPanelHeader, ConversationShellHost, ConversationSideBarActions, ConversationSideBarBottom, ConversationSideBarDeputies, ConversationStage } from "./conversation/conversation-shell.js";
import { setArenaInsets, type ArenaInsets } from "./conversation/arena-insets.js";
import { closeConversationSurface } from "./conversation/conversation-surface-store.js";
import { setConversationOperationRename } from "./conversation/conversation-slots.js";
import { useT } from "../../../core/client/src/i18n/index.js";

const STABLE_RAIL_API: ClientApiCapability = createHostCapabilities().api;
const DEFAULT_SHELL_WIDTH = 560;
const DEFAULT_SHELL_HEIGHT = 360;
// 부유 크롬 카드의 가장자리 인셋(12px) + 카드와 아레나 사이 숨(12px). 카드 자신의 폭에 더해
// 아레나 인셋이 된다 — CSS의 카드 인셋(var(--space-3))과 한 값이어야 한다.
const CHROME_FLOAT_GUTTER = 24;

interface OperationsProps {
  readonly state: ConsoleState;
  readonly onDeferredDeletion: (deletion: DeferredDeletionReceipt | null) => void;
  readonly onArchived: (outcome: ArchiveOutcome) => void;
  readonly deletionToast?: ReactNode;
}

export function Operations({ state, onDeferredDeletion, onArchived, deletionToast }: OperationsProps) {
  const viewedTheaterId = useViewedTheaterId();
  const registry = usePluginRegistry();
  const viewMode = useViewMode();
  const globalSettings = useGlobalSettingsStore();
  const language = resolveConsoleLanguage(globalSettings.state?.language ?? "auto");
  const t = useT();
  const [mutationError, setMutationError] = useState<{ readonly retry: () => void } | null>(null);
  const [operationMenu, setOperationMenu] = useState<{
    readonly operationId: string;
    readonly anchor: DOMRect;
    readonly returnFocus?: HTMLElement | null;
    readonly align?: GroupContextMenuAlign;
  } | null>(null);

  // ── 아레나 인셋 ─────────────────────────────────────────────────────────────
  // 사이드바·레일이 가운데 칸을 밀어낸 폭. 플러그인 지도(getMapInsets)와 대화 칸이 같은 스토어를 읽는다.
  // 스토어에는 부유 카드 여백을 포함한 점유를 심고, 대화 칸에는 그 여백을 뺀 실제 열 폭을 넘긴다.
  const sideBar = useSideBarState();
  const railOccupiedPx = useRailSettledPx();
  const sideBarOccupiedPx = sideBarOccupiedWidth(sideBar);
  const sideBarInset = sideBarOccupiedPx > 0 ? sideBarOccupiedPx + CHROME_FLOAT_GUTTER : 0;
  const arenaInsets: ArenaInsets = useMemo(() => ({
    left: sideBarInset,
    top: 0,
    right: railOccupiedPx > 0 ? railOccupiedPx + CHROME_FLOAT_GUTTER : 0,
    bottom: 0,
  }), [railOccupiedPx, sideBarInset]);
  useEffect(() => {
    setArenaInsets(arenaInsets);
  }, [arenaInsets]);
  const followedSideBarInset = useSideBarFollowedInset(sideBarInset);
  const conversationInsets: ArenaInsets = useMemo(() => ({
    left: Math.max(0, followedSideBarInset - CHROME_FLOAT_GUTTER),
    top: 0,
    right: railOccupiedPx,
    bottom: 0,
  }), [followedSideBarInset, railOccupiedPx]);

  const stateRef = useRef(state);
  const operationMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  stateRef.current = state;

  // 여는 제스처로 이어지는 휴면 재개 — 대화 화면에서는 여는 제스처가 곧 재개 판정이다.
  //
  // 자동 재개는 관측된 런타임 축 위에서만 한다. 축이 권위를 갖지 못한 구간의 휴면 표시는 사실이
  // 아니라 보수적 폭백이고(pluginRuntimeState 가 degraded 를 플러그인에 넘기지 않는 것과 같은 이유),
  // 사용자가 누른 것은 "재개"가 아니라 "열기"라 그 위에서 프로세스를 되살리면 안 된다.
  //
  // 두 미관측 구간은 갈 길이 다르다. pending 은 곧 권위가 도착하므로 여는 제스처를 붙들었다가 그때
  // 다시 판정한다. degraded 는 언제 회복될지 모르는 구간이라 붙들지 않는다. 어느 쪽이든
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
      const operation = stateRef.current.operations.find((candidate) => candidate.id === operationId);
      if (!operation) continue;
      resumeDormantOnOpen(operationId, stateRef.current.operations, registry.providers);
    }
  }, [registry.providers, state.operationRuntimeHydration]);

  useEffect(() => {
    if (!state.operationsHydrated) return;
    for (const theater of state.theaters) pruneOperationAccents(theater.id, new Set(state.operations.filter((operation) => operation.theaterId === theater.id).map((operation) => operation.id)));
  }, [state.operations, state.theaters, state.operationsHydrated]);

  // Alt+좌우는 사이드바 표시 순서로 대화를 옮긴다. Alt+S 는 상태별 보기다.
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
      if (matchesShortcutCommand(event, "operations.sort-by-status")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleSideBarStatusAxis();
        return;
      }
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const arrowAction = resolveOperationsArrowShortcutAction(event.code);
      if (arrowAction === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const snapshot = stateRef.current;
      const theaterOperations = snapshot.operations;
      // 사이드바 'Sort by status'(statusAxis)는 순환 순서에 관여하지 않는다.
      const order = snapshot.theaters.flatMap((theater) => {
        const operations = snapshot.operations.filter((operation) => operation.theaterId === theater.id);
        return focusCycleOperationIds(operations, snapshot.groups.filter((group) => group.theaterId === theater.id), operationOrderFromNodes(operations), getTheaterGroupCollapse(theater.id).collapsedGroups);
      });
      if (order.length === 0) return;
      const nextId = nextOperationId(order, snapshot.activeOperationId, arrowAction === "focus-next" ? 1 : -1);
      if (!nextId) return;
      const operation = theaterOperations.find((candidate) => candidate.id === nextId);
      if (!operation) return;
      focusConversationOperation(operation);
      resumeIfDormant(nextId);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [resumeIfDormant, viewMode.effective]);

  // 사이드바·레일·커맨드 밴드 밖을 누르면 패널 활성화를 푼다.
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

  // 검색·ALERTS 등에서 들어온 일회성 이동 요청을 처리한다.
  useEffect(() => {
    const operationId = state.pendingOperationFocus;
    if (operationId === null) return;
    if (viewMode.effective === "mobile") {
      const operation = state.operations.find((candidate) => candidate.id === operationId);
      if (operation) {
        // 플러그인 화면(목표 상세 등)에서 세션 행을 눌러 온 요청이면 그 화면 대신 Operation이 서야 한다.
        // 대화 탭으로 착지하라는 요청(`mobile.conversationPane`)이 이 대화에 걸려 있으면 그 정보 화면이 선다.
        setMobileDestination(takeMobileConversationDestination(operationId));
        const url = new URL(window.location.href);
        url.searchParams.set("op", operationId);
        // Operation끼리의 이동은 history를 늘리지 않는다 — 뒤로는 홈(대화 목록)이 받는다(S-51).
        if (new URL(window.location.href).searchParams.get("op") !== operationId) {
          window.history.replaceState({ ...window.history.state, fleetMobileOperation: true }, "", url);
        }
        window.dispatchEvent(new Event("popstate"));
      }
      consumeOperationFocus();
      return;
    }
    const operation = state.operations.find((candidate) => candidate.id === operationId);
    if (operation) focusConversationOperation(operation);
    consumeOperationFocus();
  }, [viewedTheaterId, state.operations, state.pendingOperationFocus, viewMode.effective]);

  const theaterOperations = state.operations;
  const pooledOperations = useMemo(() => [...state.operations, ...state.nestedOperations], [state.operations, state.nestedOperations]);
  const handleSideBarLaunchKind = useCallback((
    pluginId: string | null,
    kind: OperationLaunchKind,
    variant?: Readonly<Record<string, string>>,
    groupId?: string | null,
    launchTheaterId: string | null = getViewedTheaterId(),
  ) => {
    if (!launchTheaterId) return;
    void launchViaPlugin(pluginId, kind, defaultLaunchGeometry(), launchTheaterId, registry.providers, variant, groupId);
  }, [registry.providers]);

  const handleRailLaunchOperation = useCallback((pluginId: string | null, kind: OperationLaunchKind) => {
    handleSideBarLaunchKind(pluginId, kind);
  }, [handleSideBarLaunchKind]);
  const toolsContext = useRailPanelContext(viewedTheaterId, STABLE_RAIL_API, handleRailLaunchOperation);

  // 새 세션 컴포저가 명시한 등록 Theater로 바로 실행한다. 보기 문맥을 전환하지 않는다.
  useEffect(() => {
    const request = state.pendingLaunch;
    if (!request || !state.theaters.some((theater) => theater.id === request.theaterId)) return;
    consumeLaunch();
    void launchViaPlugin(request.pluginId, request.kind, defaultLaunchGeometry(), request.theaterId, registry.providers, request.variant)
      .then(() => {
        for (const attachment of request.attachments ?? []) URL.revokeObjectURL(attachment.previewUrl);
      })
      .catch((error: unknown) => {
        const draft = request.variant.prompt ?? "";
        // 거절은 보낸 표면으로 돌아간다 — 폰은 새 대화 시트, 데스크톱은 새 세션 화면이다.
        rejectNewSession({
          theaterId: request.theaterId,
          mobile: getViewModeSnapshot().effective === "mobile",
          draft: draft.length > 0 ? draft : null,
          attachments: request.attachments ?? null,
          errorCode: error instanceof Error ? error.message : null,
          shortenByChars: readShortenByChars(error),
        });
      });
  }, [registry.providers, state.theaters, state.pendingLaunch]);

  const handleFocus = useCallback((operationId: string) => {
    const operation = stateRef.current.operations.find((candidate) => candidate.id === operationId);
    if (!operation) return;
    focusConversationOperation(operation);
    resumeIfDormant(operationId);
  }, [resumeIfDormant]);

  const handleResume = useCallback((operationId: string) => {
    const operation = stateRef.current.operations.find((candidate) => candidate.id === operationId);
    if (!operation) return;
    const resume = () => resumeOperationInPlace(operationId, stateRef.current.operations, registry.providers, handleFocus);
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

  useEffect(() => setConversationOperationRename(handleRename), [handleRename]);

  const handleSetGroupId = useCallback((operationId: string, groupId: string | null) => {
    runMutation(
      () => patchOperation(operationId, { groupId }).then(refreshOperations),
      refreshOperations,
    );
  }, [refreshOperations, runMutation]);

  const handleCreateGroup = useCallback((theaterId: string, name: string, operationId?: string) => {
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

  const closeOperationMenu = useCallback(() => {
    if (document.hasFocus()) operationMenuReturnFocusRef.current?.focus();
    setOperationMenu(null);
  }, []);
  useEffect(() => {
    setOperationMenu(null);
  }, [viewedTheaterId]);
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

  const handleSetTheaterAlias = useCallback((theaterId: string, alias: string | null) => {
    runMutation(() => patchTheaterAlias(theaterId, alias).then(refreshTheaters), refreshTheaters);
  }, [refreshTheaters, runMutation]);

  const handleUngroupAll = useCallback((groupId: string) => {
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
    void archiveOperationFromUi(operationId).then((outcome) => { if (outcome) onArchived(outcome); });
  }, [onArchived]);

  const poolCapabilities = useHostCapabilities(() => {
    void fetchOperations(null).then(hydrateOperations).catch(() => {});
  });
  const defaultBodyConfig = useCallback((operation: OperationNode): OperationBodyConfig => ({
    active: state.activeOperationId === operation.id,
    geometry: operation.geometry ?? ensurePluginGeometry(operation),
    operation,
    runtimeState: pluginRuntimeState(state.operationRuntime, state.operationRuntimeHydration, operation.id),
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

  const sideBarChrome = (
    <OperationsSideBar
      theaters={state.theaters}
      operations={state.operations}
      groups={state.groups}
      activeOperationId={state.activeOperationId}
      operationNotifications={state.operationNotifications}
      addingTheater={state.addingTheater}
      theaterError={state.theaterError}
      onClose={handleClose}
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
      onSetTheaterAlias={handleSetTheaterAlias}
      onUngroupAll={handleUngroupAll}
      onAddTheater={handleAddTheater}
      onCancelAddTheater={cancelAddTheater}
      onForgetTheater={handleForgetTheater}
      topStripVariant="compact"
      topStripTrailing={<ConversationSideBarActions />}
      topStripCenter={<ConversationSideBarDeputies />}
      archiveInTheaterHeader
      bottomAccessory={<ConversationSideBarBottom connection={state.connection} />}
    />
  );
  const mutationErrorBanner = mutationError ? (
    <p className="operations-mutation-error" role="alert">
      {t("operations.mutation.failed")}
      <button type="button" className="operations-mutation-retry" onClick={mutationError.retry}>
        {t("operations.mutation.retry")}
      </button>
    </p>
  ) : null;
  const toastRegion = (
    <div className="operations-toast-region" style={{ left: conversationInsets.left, right: conversationInsets.right, bottom: conversationInsets.bottom }}>
      <div className="app-toast-host">
        {deletionToast}
      </div>
    </div>
  );
  const operationMenuLayer = operationMenu && menuOperation ? (
    <GroupContextMenu
      kind="chip"
      operation={menuOperation}
      groups={state.groups.filter((group) => group.theaterId === menuOperation.theaterId)}
      accentKey={getTheaterGroupCollapse(menuOperation.theaterId).operationAccent[menuOperation.id]
        ?? operationAccentFromNode(menuOperation)}
      anchor={operationMenu.anchor}
      align={operationMenu.align}
      actions={{
        onSetAccent: (key) => handleSetAccent(menuOperation.id, key),
        onSetGroupId: (groupId) => handleSetGroupId(menuOperation.id, groupId),
        onCreateGroup: (name) => handleCreateGroup(menuOperation.theaterId, name, menuOperation.id),
        onCloseOperation: () => handleClose(menuOperation.id),
      }}
      onClose={closeOperationMenu}
    />
  ) : null;
  const conversationShell = (
    <div className="console-body is-conversation">
      <ConversationShellHost />
      {mutationErrorBanner}
      {sideBarChrome}
      <ConversationStage
        state={state}
        insets={conversationInsets}
        language={language}
        operationKinds={registry.operationKinds}
        onClose={handleClose}
        toolContext={toolsContext}
      />
      {toastRegion}
      <RightRail theaterId={viewedTheaterId} api={STABLE_RAIL_API} onLaunchOperation={handleRailLaunchOperation} header={<ConversationPanelHeader context={toolsContext} />} reservedArenaWidth={CONVERSATION_RESERVED_ARENA_WIDTH} />
      {operationMenuLayer}
    </div>
  );
  const shell = viewMode.effective === "mobile" ? (
    <MobileShell
      operations={theaterOperations}
      activeOperationId={state.activeOperationId}
      operationRuntime={state.operationRuntime}
      operationRuntimeHydration={state.operationRuntimeHydration}
      operationNotifications={state.operationNotifications}
      theme={state.activeTheme}
      language={language}
      operationKinds={registry.operationKinds}
      capabilities={poolCapabilities}
      onSelectOperation={setActiveOperation}
      onCloseOperation={handleClose}
    />
  ) : conversationShell;
  return (
    <OperationBodyPool
      releaseParkedBodies={viewMode.effective !== "mobile"}
      operations={pooledOperations}
      operationKinds={registry.operationKinds}
      capabilities={poolCapabilities}
      defaultConfig={defaultBodyConfig}
    >
      {shell}
    </OperationBodyPool>
  );
}

function focusConversationOperation(operation: OperationNode): void {
  revealOperationStage();
  closeConversationSurface();
  setActiveOperation(operation.id);
  requestOperationKeyboardFocus(operation.id);
}

function settleReorderPatches(patches: readonly Promise<unknown>[]): Promise<void> {
  return Promise.allSettled(patches).then((results) => {
    if (results.some((result) => result.status === "rejected")) throw new Error("reorder_partial_failure");
  });
}

function readShortenByChars(error: unknown): number | null {
  if (!(error instanceof Error) || !("shortenByChars" in error)) return null;
  const value = (error as { readonly shortenByChars?: unknown }).shortenByChars;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ensurePluginGeometry(operation: OperationNode): OperationGeometry {
  return operation.geometry ?? { x: 0, y: 0, width: DEFAULT_SHELL_WIDTH, height: DEFAULT_SHELL_HEIGHT, zIndex: 0 };
}

function defaultLaunchGeometry(): OperationGeometry {
  return { x: 0, y: 0, width: DEFAULT_SHELL_WIDTH, height: DEFAULT_SHELL_HEIGHT, zIndex: 0 };
}

async function launchViaPlugin(
  pluginId: string | null,
  kind: OperationLaunchKind,
  geometry: OperationGeometry,
  theaterId: string,
  plugins: readonly ClientExecutionProvider[],
  variant?: Readonly<Record<string, string>>,
  groupId?: string | null,
): Promise<void> {
  await createLaunchedOperation(pluginId, kind, geometry, theaterId, plugins, variant, groupId);
}

async function createLaunchedOperation(
  pluginId: string | null,
  kind: OperationLaunchKind,
  geometry: OperationGeometry,
  theaterId: string,
  plugins: readonly ClientExecutionProvider[],
  variant?: Readonly<Record<string, string>>,
  groupId?: string | null,
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
  if (newOperationId && groupId) await patchOperation(newOperationId, { groupId }).catch(() => {});
  await fetchOperations(null).then(hydrateOperations).catch(() => {});
  if (!newOperationId) return;
  const operationHydrated = getState().operations.some((operation) => operation.id === newOperationId);
  if (operationHydrated) focusOperation(newOperationId);
}
