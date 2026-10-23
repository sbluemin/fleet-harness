import { getViewedTheaterId, useViewedTheaterId } from "../../../core/client/src/integration/viewed-theater.js";
import { useHostCapabilities } from "../../../core/client/src/integration/use-host-capabilities.js";
import { pluginRuntimeState } from "../../execution/client/objective-activity.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ObjectiveLaunchKind } from "../../objectives/shared/records/types.js";
import type { ClientApiCapability } from "@fleet-console/infra/http/client-ports";
import type { ClientFeatureDescriptor } from "../shared/feature-surfaces.js";

import { ApiError, createGroup, deleteGroup, fetchGroups, fetchObjectiveRecords, fetchTheaters, patchObjective, patchTheaterAlias, patchTheaterOrder, renameObjective, updateGroup, type DeferredDeletionReceipt } from "../../../core/client/src/integration/api.js";
import { clearActiveObjective, shouldReleaseActiveObjective } from "../../../core/client/src/integration/active-objective-surface.js";
import { blocksObjectiveRecordsShortcutWhileEditing, isBlockingDialogOpen, resolveObjectiveRecordsArrowShortcutAction } from "../../../core/client/src/integration/shortcuts.js";
import { archiveObjectiveFromUi, resumeDormantOnOpen, resumeObjectiveInPlace, type ArchiveOutcome } from "../../../core/client/src/integration/objective-actions.js";
import { forgetTheaterCompletely, registerTheaterFromPath } from "./theater.js";
import { GroupContextMenu, type GroupContextMenuAlign } from "./sidebar/group-context-menu.js";
import { objectiveRecordAccentFromNode } from "./objective-accent.js";
import { getTheaterGroupCollapse, pruneObjectiveAccents, toggleTheaterStatusAxis } from "./sidebar/group-collapse-store.js";
import { createHostCapabilities } from "../../../core/client/src/integration/feature-capabilities.js";
import { useFeatureRegistry } from "../../../core/client/src/integration/feature-registry.js";
import { RightRail, useRailPanelContext } from "../../../core/client/src/chrome/rail/right-rail.js";
import { ObjectiveRecordsSideBar } from "./sidebar/objective-records-side-bar.js";
import { useSideBarFollowedInset } from "./sidebar/side-bar-motion.js";
import { useContextMenuKeyboard } from "./sidebar/context-menu-keyboard.js";
import { sideBarOccupiedWidth, useSideBarState } from "./sidebar/objective-records-side-bar-store.js";
import { useRailSettledPx } from "../../../core/client/src/chrome/rail/rail-store.js";
import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { shouldHandleObjectiveRecordsKeyboardShortcut } from "../../../core/client/src/chrome/components/keyboard-shortcuts-dialog.js";
import { isShortcutRecording, matchesShortcutCommand } from "../../../core/client/src/integration/shortcut-bindings.js";
import { cancelAddTheater, consumeObjectiveFocus, consumeLaunch, rejectNewSession, focusCycleObjectiveIds, focusObjective, getState, hydrateGroups, hydrateObjectiveRecords, hydrateTheaters, nextObjectiveId, objectiveRecordOrderFromNodes, requestObjectiveKeyboardFocus, revealObjectiveStage, setActiveObjective } from "../../../core/client/src/integration/store.js";
import type { ConsoleState, ObjectiveGeometry, ObjectiveRecord } from "../../../core/client/src/integration/types.js";
import { MobileShell } from "../../../core/client/src/chrome/mobile/mobile-shell.js";
import { setMobileDestination, takeMobileConversationDestination } from "../../../core/client/src/chrome/mobile/mobile-store.js";
import { ObjectiveBodyPool, type ObjectiveBodyConfig } from "../../../core/client/src/chrome/mobile/objective-body-pool.js";
import { getViewModeSnapshot, useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import { resolveConsoleLanguage } from "../../updates/client/whatsnew-i18n.js";
import { CONVERSATION_RESERVED_ARENA_WIDTH, ConversationPanelHeader, ConversationShellHost, ConversationSideBarActions, ConversationSideBarBottom, ConversationSideBarDeputies, ConversationStage } from "./conversation/conversation-shell.js";
import { setArenaInsets, type ArenaInsets } from "./conversation/arena-insets.js";
import { closeConversationSurface } from "./conversation/conversation-surface-store.js";
import { setConversationObjectiveRename } from "./conversation/conversation-slots.js";
import { useT } from "../../../core/client/src/i18n/index.js";

const STABLE_RAIL_API: ClientApiCapability = createHostCapabilities().api;
const DEFAULT_SHELL_WIDTH = 560;
const DEFAULT_SHELL_HEIGHT = 360;
// 부유 크롬 카드의 가장자리 인셋(12px) + 카드와 아레나 사이 숨(12px). 카드 자신의 폭에 더해
// 아레나 인셋이 된다 — CSS의 카드 인셋(var(--space-3))과 한 값이어야 한다.
const CHROME_FLOAT_GUTTER = 24;

interface ObjectiveRecordsProps {
  readonly state: ConsoleState;
  readonly onDeferredDeletion: (deletion: DeferredDeletionReceipt | null) => void;
  readonly onArchived: (outcome: ArchiveOutcome) => void;
  readonly deletionToast?: ReactNode;
}

export function ObjectiveRecords({ state, onDeferredDeletion, onArchived, deletionToast }: ObjectiveRecordsProps) {
  const viewedTheaterId = useViewedTheaterId();
  const registry = useFeatureRegistry();
  const viewMode = useViewMode();
  const globalSettings = useGlobalSettingsStore();
  const language = resolveConsoleLanguage(globalSettings.state?.language ?? "auto");
  const t = useT();
  const [mutationError, setMutationError] = useState<{ readonly retry: () => void } | null>(null);
  const [objectiveRecordMenu, setObjectiveMenu] = useState<{
    readonly objectiveId: string;
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
  const objectiveRecordMenuReturnFocusRef = useRef<HTMLElement | null>(null);
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
  const resumeIfDormant = useCallback((objectiveId: string) => {
    const hydration = getState().objectiveRecordRuntimeHydration;
    if (hydration !== "ready") {
      if (hydration === "pending") deferredOpenResumeRef.current.add(objectiveId);
      return;
    }
    resumeDormantOnOpen(objectiveId, stateRef.current.objectiveRecords, registry.providers);
  }, [registry.providers]);

  useEffect(() => {
    // degraded 는 "모른다"는 뜻이다 — 붙들어 둔 제스처를 사실로 승격하지 않고 버린다.
    if (state.objectiveRecordRuntimeHydration === "degraded") {
      deferredOpenResumeRef.current.clear();
      return;
    }
    if (state.objectiveRecordRuntimeHydration !== "ready" || deferredOpenResumeRef.current.size === 0) return;
    const deferred = [...deferredOpenResumeRef.current];
    deferredOpenResumeRef.current.clear();
    for (const objectiveId of deferred) {
      const objectiveRecord = stateRef.current.objectiveRecords.find((candidate) => candidate.id === objectiveId);
      if (!objectiveRecord) continue;
      resumeDormantOnOpen(objectiveId, stateRef.current.objectiveRecords, registry.providers);
    }
  }, [registry.providers, state.objectiveRecordRuntimeHydration]);

  useEffect(() => {
    if (!state.objectiveRecordsHydrated) return;
    for (const theater of state.theaters) pruneObjectiveAccents(theater.id, new Set(state.objectiveRecords.filter((objectiveRecord) => objectiveRecord.theaterId === theater.id).map((objectiveRecord) => objectiveRecord.id)));
  }, [state.objectiveRecords, state.theaters, state.objectiveRecordsHydrated]);

  // Alt+좌우는 사이드바 표시 순서로 대화를 옮긴다. Alt+S 는 지금 보고 있는 Theater 의 상태별 보기다.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (viewMode.effective === "mobile") return;
      if (!shouldHandleObjectiveRecordsKeyboardShortcut()) return;
      if (isShortcutRecording()) return;
      if (isBlockingDialogOpen()) return;
      const active = document.activeElement;
      const editing = active instanceof HTMLElement
        && active.matches("input, textarea, [contenteditable='true']")
        && !active.closest(".xterm");
      if (blocksObjectiveRecordsShortcutWhileEditing(editing, event)) return;
      if (matchesShortcutCommand(event, "objectives.sort-by-status")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleTheaterStatusAxis(getViewedTheaterId());
        return;
      }
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const arrowAction = resolveObjectiveRecordsArrowShortcutAction(event.code);
      if (arrowAction === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const snapshot = stateRef.current;
      const theaterObjectiveRecords = snapshot.objectiveRecords;
      // 사이드바 'Sort by status'(statusAxis)는 순환 순서에 관여하지 않는다.
      const order = snapshot.theaters.flatMap((theater) => {
        const objectiveRecords = snapshot.objectiveRecords.filter((objectiveRecord) => objectiveRecord.theaterId === theater.id);
        return focusCycleObjectiveIds(objectiveRecords, snapshot.groups.filter((group) => group.theaterId === theater.id), objectiveRecordOrderFromNodes(objectiveRecords), getTheaterGroupCollapse(theater.id).collapsedGroups);
      });
      if (order.length === 0) return;
      const nextId = nextObjectiveId(order, snapshot.activeObjectiveId, arrowAction === "focus-next" ? 1 : -1);
      if (!nextId) return;
      const objectiveRecord = theaterObjectiveRecords.find((candidate) => candidate.id === nextId);
      if (!objectiveRecord) return;
      focusConversationObjective(objectiveRecord);
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
      if (stateRef.current.activeObjectiveId === null) return;
      if (!shouldReleaseActiveObjective(event.target)) return;
      clearActiveObjective();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [viewMode.effective]);

  // 검색·ALERTS 등에서 들어온 일회성 이동 요청을 처리한다.
  useEffect(() => {
    const objectiveId = state.pendingObjectiveFocus;
    if (objectiveId === null) return;
    if (viewMode.effective === "mobile") {
      const objectiveRecord = state.objectiveRecords.find((candidate) => candidate.id === objectiveId);
      if (objectiveRecord) {
        // 플러그인 화면(목표 상세 등)에서 세션 행을 눌러 온 요청이면 그 화면 대신 Objective이 서야 한다.
        // 대화 탭으로 착지하라는 요청(`mobile.conversationPane`)이 이 대화에 걸려 있으면 그 정보 화면이 선다.
        setMobileDestination(takeMobileConversationDestination(objectiveId));
        const url = new URL(window.location.href);
        url.searchParams.set("op", objectiveId);
        // Objective끼리의 이동은 history를 늘리지 않는다 — 뒤로는 홈(대화 목록)이 받는다(S-51).
        if (new URL(window.location.href).searchParams.get("op") !== objectiveId) {
          window.history.replaceState({ ...window.history.state, fleetMobileObjective: true }, "", url);
        }
        window.dispatchEvent(new Event("popstate"));
      }
      consumeObjectiveFocus();
      return;
    }
    const objectiveRecord = state.objectiveRecords.find((candidate) => candidate.id === objectiveId);
    if (objectiveRecord) focusConversationObjective(objectiveRecord);
    consumeObjectiveFocus();
  }, [viewedTheaterId, state.objectiveRecords, state.pendingObjectiveFocus, viewMode.effective]);

  const theaterObjectiveRecords = state.objectiveRecords;
  const pooledObjectiveRecords = useMemo(() => [...state.objectiveRecords, ...state.nestedObjectiveRecords], [state.objectiveRecords, state.nestedObjectiveRecords]);
  const handleSideBarLaunchKind = useCallback((
    pluginId: string | null,
    kind: ObjectiveLaunchKind,
    variant?: Readonly<Record<string, string>>,
    groupId?: string | null,
    launchTheaterId: string | null = getViewedTheaterId(),
  ) => {
    if (!launchTheaterId) return;
    void launchViaPlugin(pluginId, kind, defaultLaunchGeometry(), launchTheaterId, registry.providers, variant, groupId);
  }, [registry.providers]);

  const handleRailLaunchObjective = useCallback((pluginId: string | null, kind: ObjectiveLaunchKind) => {
    handleSideBarLaunchKind(pluginId, kind);
  }, [handleSideBarLaunchKind]);
  const toolsContext = useRailPanelContext(viewedTheaterId, STABLE_RAIL_API, handleRailLaunchObjective);

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

  const handleFocus = useCallback((objectiveId: string) => {
    const objectiveRecord = stateRef.current.objectiveRecords.find((candidate) => candidate.id === objectiveId);
    if (!objectiveRecord) return;
    focusConversationObjective(objectiveRecord);
    resumeIfDormant(objectiveId);
  }, [resumeIfDormant]);

  const handleResume = useCallback((objectiveId: string) => {
    const objectiveRecord = stateRef.current.objectiveRecords.find((candidate) => candidate.id === objectiveId);
    if (!objectiveRecord) return;
    const resume = () => resumeObjectiveInPlace(objectiveId, stateRef.current.objectiveRecords, registry.providers, handleFocus);
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

  const refreshObjectiveRecords = useCallback(
    () => fetchObjectiveRecords(null).then(hydrateObjectiveRecords),
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
  const refreshObjectiveRecordsAndGroups = useCallback(
    () => Promise.all([refreshObjectiveRecords(), refreshGroups()]).then(() => undefined),
    [refreshGroups, refreshObjectiveRecords],
  );

  const handleSetAccent = useCallback((objectiveId: string, accentKey: string | null) => {
    runMutation(
      () => patchObjective(objectiveId, { accent: accentKey }).then(refreshObjectiveRecords),
      refreshObjectiveRecords,
    );
  }, [refreshObjectiveRecords, runMutation]);

  const handleRename = useCallback((objectiveId: string, title: string) => {
    runMutation(
      () => renameObjective(objectiveId, title).then(refreshObjectiveRecords),
      refreshObjectiveRecords,
    );
  }, [refreshObjectiveRecords, runMutation]);

  useEffect(() => setConversationObjectiveRename(handleRename), [handleRename]);

  const handleSetGroupId = useCallback((objectiveId: string, groupId: string | null) => {
    runMutation(
      () => patchObjective(objectiveId, { groupId }).then(refreshObjectiveRecords),
      refreshObjectiveRecords,
    );
  }, [refreshObjectiveRecords, runMutation]);

  const handleCreateGroup = useCallback((theaterId: string, name: string, objectiveId?: string) => {
    let createdGroupId: string | null = null;
    runMutation(
      async () => {
        const group = createdGroupId
          ? { id: createdGroupId }
          : await createGroup({ theaterId, name, color: "blue" });
        createdGroupId = group.id;
        if (objectiveId) await patchObjective(objectiveId, { groupId: group.id });
        await refreshObjectiveRecordsAndGroups();
      },
      refreshObjectiveRecordsAndGroups,
    );
  }, [refreshObjectiveRecordsAndGroups, runMutation]);

  const closeObjectiveMenu = useCallback(() => {
    if (document.hasFocus()) objectiveRecordMenuReturnFocusRef.current?.focus();
    setObjectiveMenu(null);
  }, []);
  useEffect(() => {
    setObjectiveMenu(null);
  }, [viewedTheaterId]);
  const menuObjective = objectiveRecordMenu
    ? state.objectiveRecords.find((objectiveRecord) => objectiveRecord.id === objectiveRecordMenu.objectiveId) ?? null
    : null;
  objectiveRecordMenuReturnFocusRef.current = objectiveRecordMenu?.returnFocus ?? null;
  useContextMenuKeyboard({
    open: menuObjective !== null,
    menuSelector: '.group-context-menu-card[role="menu"]',
    returnFocusRef: objectiveRecordMenuReturnFocusRef,
    onEscape: closeObjectiveMenu,
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
        await refreshObjectiveRecordsAndGroups();
      },
      refreshObjectiveRecordsAndGroups,
    );
  }, [refreshObjectiveRecordsAndGroups, runMutation]);

  const handleClose = useCallback((objectiveId: string) => {
    void archiveObjectiveFromUi(objectiveId).then((outcome) => { if (outcome) onArchived(outcome); });
  }, [onArchived]);

  const poolCapabilities = useHostCapabilities(() => {
    void fetchObjectiveRecords(null).then(hydrateObjectiveRecords).catch(() => {});
  });
  const defaultBodyConfig = useCallback((objectiveRecord: ObjectiveRecord): ObjectiveBodyConfig => ({
    active: state.activeObjectiveId === objectiveRecord.id,
    geometry:  ensurePluginGeometry(objectiveRecord),
    objectiveRecord,
    runtimeState: pluginRuntimeState(state.objectiveRecordRuntime, state.objectiveRecordRuntimeHydration, objectiveRecord.id),
    bodyLive: false,
    theme: state.activeTheme,
    language,
    zoom: 1,
    onActivate: () => setActiveObjective(objectiveRecord.id),
    onClose: () => handleClose(objectiveRecord.id),
    onGeometryChange: () => {},
    onRequestCompanions: () => {},
    companionsOpen: false,
    hiddenCompanionPanelIds: [],
    onSetCompanionPanelVisible: () => {},
  }), [handleClose, language, state.activeObjectiveId, state.activeTheme]);

  const handleAddTheater = useCallback(async (path: string) => {
    await registerTheaterFromPath(path);
  }, []);

  const handleForgetTheater = useCallback(async (theaterId: string) => {
    onDeferredDeletion(await forgetTheaterCompletely(theaterId));
  }, [onDeferredDeletion]);

  const sideBarChrome = (
    <ObjectiveRecordsSideBar
      theaters={state.theaters}
      objectiveRecords={state.objectiveRecords}
      groups={state.groups}
      activeObjectiveId={state.activeObjectiveId}
      objectiveRecordNotifications={state.objectiveRecordNotifications}
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
      bottomAccessory={<ConversationSideBarBottom connection={state.connection} />}
    />
  );
  const mutationErrorBanner = mutationError ? (
    <p className="objective-records-mutation-error" role="alert">
      {t("objectiveRecords.mutation.failed")}
      <button type="button" className="objective-records-mutation-retry" onClick={mutationError.retry}>
        {t("objectiveRecords.mutation.retry")}
      </button>
    </p>
  ) : null;
  const toastRegion = (
    <div className="objective-records-toast-region" style={{ left: conversationInsets.left, right: conversationInsets.right, bottom: conversationInsets.bottom }}>
      <div className="app-toast-host">
        {deletionToast}
      </div>
    </div>
  );
  const objectiveRecordMenuLayer = objectiveRecordMenu && menuObjective ? (
    <GroupContextMenu
      kind="chip"
      objectiveRecord={menuObjective}
      groups={state.groups.filter((group) => group.theaterId === menuObjective.theaterId)}
      accentKey={getTheaterGroupCollapse(menuObjective.theaterId).objectiveRecordAccent[menuObjective.id]
        ?? objectiveRecordAccentFromNode(menuObjective)}
      anchor={objectiveRecordMenu.anchor}
      align={objectiveRecordMenu.align}
      actions={{
        onSetAccent: (key) => handleSetAccent(menuObjective.id, key),
        onSetGroupId: (groupId) => handleSetGroupId(menuObjective.id, groupId),
        onCreateGroup: (name) => handleCreateGroup(menuObjective.theaterId, name, menuObjective.id),
        onCloseObjective: () => handleClose(menuObjective.id),
      }}
      onClose={closeObjectiveMenu}
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
        objectiveRecordKinds={registry.objectiveRecordKinds}
        onClose={handleClose}
        toolContext={toolsContext}
      />
      {toastRegion}
      <RightRail theaterId={viewedTheaterId} api={STABLE_RAIL_API} onLaunchObjective={handleRailLaunchObjective} header={<ConversationPanelHeader context={toolsContext} />} reservedArenaWidth={CONVERSATION_RESERVED_ARENA_WIDTH} />
      {objectiveRecordMenuLayer}
    </div>
  );
  const shell = viewMode.effective === "mobile" ? (
    <MobileShell
      objectiveRecords={theaterObjectiveRecords}
      activeObjectiveId={state.activeObjectiveId}
      objectiveRecordRuntime={state.objectiveRecordRuntime}
      objectiveRecordRuntimeHydration={state.objectiveRecordRuntimeHydration}
      objectiveRecordNotifications={state.objectiveRecordNotifications}
      theme={state.activeTheme}
      language={language}
      objectiveRecordKinds={registry.objectiveRecordKinds}
      capabilities={poolCapabilities}
      onSelectObjective={setActiveObjective}
      onCloseObjective={handleClose}
    />
  ) : conversationShell;
  return (
    <ObjectiveBodyPool
      releaseParkedBodies={viewMode.effective !== "mobile"}
      objectiveRecords={pooledObjectiveRecords}
      objectiveRecordKinds={registry.objectiveRecordKinds}
      capabilities={poolCapabilities}
      defaultConfig={defaultBodyConfig}
    >
      {shell}
    </ObjectiveBodyPool>
  );
}

function focusConversationObjective(objectiveRecord: ObjectiveRecord): void {
  revealObjectiveStage();
  closeConversationSurface();
  setActiveObjective(objectiveRecord.id);
  requestObjectiveKeyboardFocus(objectiveRecord.id);
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

function ensurePluginGeometry(objectiveRecord: ObjectiveRecord): ObjectiveGeometry {
  return  { x: 0, y: 0, width: DEFAULT_SHELL_WIDTH, height: DEFAULT_SHELL_HEIGHT, zIndex: 0 };
}

function defaultLaunchGeometry(): ObjectiveGeometry {
  return { x: 0, y: 0, width: DEFAULT_SHELL_WIDTH, height: DEFAULT_SHELL_HEIGHT, zIndex: 0 };
}

async function launchViaPlugin(
  pluginId: string | null,
  kind: ObjectiveLaunchKind,
  geometry: ObjectiveGeometry,
  theaterId: string,
  plugins: readonly ClientFeatureDescriptor[],
  variant?: Readonly<Record<string, string>>,
  groupId?: string | null,
): Promise<void> {
  await createLaunchedObjective(pluginId, kind, geometry, theaterId, plugins, variant, groupId);
}

async function createLaunchedObjective(
  pluginId: string | null,
  kind: ObjectiveLaunchKind,
  geometry: ObjectiveGeometry,
  theaterId: string,
  plugins: readonly ClientFeatureDescriptor[],
  variant?: Readonly<Record<string, string>>,
  groupId?: string | null,
): Promise<void> {
  const plugin = plugins.find((p) => p.id === pluginId);
  const resync = () => { void fetchObjectiveRecords(null).then(hydrateObjectiveRecords).catch(() => {}); };
  const capabilities = createHostCapabilities(resync);
  let newObjectiveId: string | null = null;
  if (plugin?.launch) {
    const result = await plugin.launch({ theaterId, kind, geometry, objectiveRecords: capabilities.objectiveRecords, variant });
    newObjectiveId = result.id;
  } else {
    const objectiveRecord = await capabilities.objectiveRecords.create({
      theaterId,
      type: kind.type,
      pluginId,
      title: kind.title,
      geometry,
    });
    newObjectiveId = objectiveRecord.id;
  }
  if (newObjectiveId && groupId) await patchObjective(newObjectiveId, { groupId }).catch(() => {});
  await fetchObjectiveRecords(null).then(hydrateObjectiveRecords).catch(() => {});
  if (!newObjectiveId) return;
  const objectiveRecordHydrated = getState().objectiveRecords.some((objectiveRecord) => objectiveRecord.id === newObjectiveId);
  if (objectiveRecordHydrated) focusObjective(newObjectiveId);
}
