import { closeConversationSurface } from "../../../../../features/workspace/client/conversation/conversation-surface-store.js";
import { openTheaterInbox } from "../../../../../features/workspace/client/theater-inbox/store.js";
import { resolveTheaterInboxLanding } from "../../../../../features/workspace/client/theater-contributions.js";
import { useFeatureRegistry } from "../../integration/feature-registry.js";
import { openDefaultNewSession } from "../../../../../features/workspace/client/conversation/new-session-entry.js";
import { getViewedTheaterId } from "../../integration/viewed-theater.js";
import { useHostCapabilities } from "../../integration/use-host-capabilities.js";
import { landPaneTarget } from "../pane/pane-target.js";
import { createHostPaneTargetPorts } from "../../integration/feature-capabilities.js";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { ClientFeatureDescriptor } from "../../../../../features/workspace/shared/feature-surfaces.js";
import type { PaneSearchResult, PaneTarget } from "../../../../../features/workspace/shared/pane.js";
import { openExpandedSurface } from "../expanded-surface/store.js";
import { useDesktopRailEntries } from "../pane/pane-registry.js";
import type { RailPanelDescriptor, RailSearchResult } from "../../../../../features/workspace/shared/rail.js";
import type { TheaterInboxSectionDescriptor } from "../../../../../features/workspace/shared/theater-inbox.js";

import { ObjectiveNameMark } from "../../../../../features/execution/client/components/objective-name-mark.js";
import { ObjectiveWorkspaceContext, describeWorkspace, visibleWorkspace } from "../../../../../features/execution/client/components/objective-workspace-context.js";
import { useAgentState } from "../../../../../features/execution/client/agent/store.js";
import { setGlobalSettingsField } from "../../../../../features/settings/client/global-settings-store.js";
import {
  buildTheaterSectionSearchEntries,
  filterObjectiveSearchEntries,
  filterTheaterSectionSearchEntries,
  groupObjectiveSearchEntries,
  orderObjectiveSearchEntries,
  PALETTE_MODES,
  paletteModeForPrefix,
  parsePaletteSeed,
  RAIL_SEARCH_DEBOUNCE_MS,
  searchRailPanels,
  searchTokens,
  type ObjectiveSearchEntry,
  type PaletteMode,
  type PaletteSearchPanel,
  type RailSearchGroup,
  type TheaterSectionSearchEntry,
} from "../../integration/objective-search.js";
import { noteCommandRun, readRecentCommandIds } from "../../integration/palette-recent.js";
import { PaletteActionGlyph, PaletteCommandGlyph, PaletteRailIcon, PaletteSectionGlyph } from "./palette-glyphs.js";
import { resolveObjectiveMarkVisual } from "../../../../../features/execution/client/objective-activity.js";
import { archiveObjectiveFromUi, resumeObjectiveInPlace, type ArchiveOutcome } from "../../integration/objective-actions.js";
import { openArchiveSheet, openRestoredObjective, refreshObjectiveArchive, useObjectiveArchive } from "../../integration/objective-archive.js";
import { restoreObjectiveCluster } from "../../../../../features/execution/client/objective-records.js";
import { fetchObjectiveRecords } from "../../integration/api.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../../../features/execution/client/objective-marks.js";
import {
  buildPaletteCommands,
  groupPaletteCommands,
  matchPaletteCommands,
  type PaletteCommandAction,
  type PaletteCommandEntry,
  type PaletteCommandGroup,
  type ScoredPaletteCommand,
} from "../../integration/palette-commands.js";
import { stashCommissioningReturnFocus, stashKeyboardShortcutsReturnFocus } from "../../integration/shortcuts.js";
import { chordKeyLabels, resolveShortcutChords, shortcutCommandLabel, useShortcutOverrides } from "../../integration/shortcut-bindings.js";
import { getViewModeSnapshot, useViewMode } from "../../integration/view-mode-store.js";
import { presentRailPanel } from "../rail/rail-store.js";
import { openSettingsSurface } from "../../../../../features/settings/client/settings-door.js";
import { toggleTheaterStatusAxis } from "../../../../../features/workspace/client/sidebar/group-collapse-store.js";
import { requestSideBarObjectiveAction, type SideBarObjectiveAction } from "../../../../../features/workspace/client/sidebar/interaction.js";
import {
  closeObjectiveSearch,
  focusObjective,
  hydrateObjectiveRecords,
  getState,
  openKeyboardShortcuts,
  openOnboarding,
  openWhatsNew,
  objectiveRecordSearchEntries,
  requestSideBarAddTheater,
  setActiveTheme,
  setObjectiveSearchMode,
} from "../../integration/store.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import type { ConsoleState } from "../../integration/types.js";

interface ObjectiveSearchProps {
  readonly state: ConsoleState;
  readonly railPanels: readonly PaletteSearchPanel[];
  // feature-registry 의존을 테스트 경계 밖으로 밀기 위해 registry 직접 import 대신 prop으로 받는다.
  readonly plugins: readonly ClientFeatureDescriptor[];
  // 같은 이유로 Theater Inbox 섹션(사령관 등)도 prop으로 받는다 — 팔레트가 그 Theater 의 섹션 행을 범용으로 세운다.
  readonly theaterSections: readonly TheaterInboxSectionDescriptor[];
  // 팔레트 보관도 대화 화면·사이드바와 같은 되돌리기 큐에 receipt를 넣어야 ⌘Z가 경로에 상관없이 동작한다.
  readonly onArchived?: (outcome: ArchiveOutcome) => void;
  readonly canUndoLastClose?: () => boolean;
  /** 되돌릴 마지막 일의 종류 — 「보관 되돌리기」와 Theater 잊기의 「실행 취소」를 가른다. */
  readonly lastUndoKind?: () => "archive" | "deletion" | null;
  readonly onUndoLastClose?: () => void;
}

const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const LISTBOX_ID = "objective-search-listbox";
const UNASSIGNED_GROUP_KEY = "__unassigned__";

export function ObjectiveSearch({
  state,
  railPanels,
  plugins,
  theaterSections,
  onArchived,
  canUndoLastClose,
  lastUndoKind,
  onUndoLastClose,
}: ObjectiveSearchProps) {
  const t = useT();
  const registry = useFeatureRegistry();
  const language = useConsoleLocale();
  const desktopView = useViewMode().effective !== "mobile";
  const sessions = useAgentState().sessions;
  const railBindings = useDesktopRailEntries();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<PaletteMode>("objectiveRecords");
  const [text, setText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  // 활성 행을 마지막으로 옮긴 입력 — 키보드일 때만 활성 행이 포커스 링을 그리고, 마우스가 옮긴 행은 hover 워시뿐이다.
  const [navigation, setNavigation] = useState<"keyboard" | "pointer">("keyboard");
  const [providerSearchGroups, setRailSearchGroups] = useState<readonly RailSearchGroup[]>([]);
  const capabilities = useHostCapabilities();
  const [shellNotice, setShellNotice] = useState<string | null>(null);
  useEffect(() => setShellNotice(null), [text, mode, state.objectiveRecordSearchOpen]);
  const railSearchGroups = useMemo<readonly RailSearchGroup[]>(() => {
    if (mode !== "objectiveRecords") return [];
    const query = text.trim().toLowerCase();
    const matchesShell = query !== "" && ["shell", "셸", "쉘", "터미널", "terminal", "console"].some((alias) => alias.includes(query));
    if (!matchesShell || !desktopView) return providerSearchGroups;
    const theaterId = getViewedTheaterId();
    return [...providerSearchGroups, {
      panelId: "global-shell",
      panelTitle: "Shell",
      results: [
        { id: "open-shell", title: t("chrome.objectiveRecordSearch.openShell"), activate: () => undefined },
        ...(theaterId ? [{ id: "open-shell-here", title: t("chrome.objectiveRecordSearch.openShellHere"), activate: async () => {
          const result = await capabilities.shell.openAt({ theaterId }).catch(() => null);
          if (result?.ok) return;
          setShellNotice(t(result ? `chrome.objectiveRecordSearch.shell.${result.reason}` : "chrome.objectiveRecordSearch.shell.failed"));
          throw new Error("shell_open_refused");
        } }] : []),
      ],
    }];
  }, [providerSearchGroups, mode, text, getViewedTheaterId(), desktopView, capabilities, t]);
  // 동작 띠가 펼쳐진 Objective 행과 그 안의 선택. 띠는 한 번에 하나만 선다.
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [actionIndex, setActionIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const appliedSeedNonceRef = useRef(0);
  const resultRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchGenerationRef = useRef(0);
  const commandMode = mode === "commands";
  // 사이드바·커맨드 밴드와 같은 마크 축 — 안 본 채 끝난 Objective이 팔레트에서만 침묵하지 않게 한다.
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const archive = useObjectiveArchive();
  const [archiveNotice, setArchiveNotice] = useState(false);
  const restoringArchive = useRef(false);
  useEffect(() => {
    if (state.objectiveRecordSearchOpen) { setArchiveNotice(false); void refreshObjectiveArchive(); }
  }, [state.objectiveRecordSearchOpen]);
  const entries = useMemo(() => {
    const active = objectiveRecordSearchEntries(state);
    const activeIds = new Set(active.map((entry) => entry.objectiveId));
    const pendingIds = new Set(archive.snapshot?.pendingPurges?.flatMap((batch) => batch.objectiveIds) ?? []);
    const archivedNodes = (archive.snapshot?.entries ?? []).filter((entry) => !activeIds.has(entry.objectiveRecord.id) && !pendingIds.has(entry.objectiveRecord.id)).map((entry) => entry.objectiveRecord);
    const archived = objectiveRecordSearchEntries({ ...state, objectiveRecords: archivedNodes }).map((entry) => ({ ...entry, archived: true as const, activity: "ended" as const }));
    return [...active, ...archived];
  }, [state, archive.snapshot]);
  const filteredEntries = useMemo(
    () => mode === "objectiveRecords"
      ? orderObjectiveSearchEntries(filterObjectiveSearchEntries(entries, text), getViewedTheaterId(), searchTokens(text).length > 0)
      : [],
    [entries, mode, getViewedTheaterId(), text],
  );
  // 섹션 상태(실험 기능이 뒤늦게 알려지거나 scope가 바뀌는 일)를 팔레트가 열려 있는 동안 다시 읽는다.
  const [sectionVersion, setSectionVersion] = useState(0);
  useEffect(() => {
    if (!state.objectiveRecordSearchOpen || !desktopView) return;
    const bump = () => setSectionVersion((version) => version + 1);
    const stops = theaterSections.map((section) => {
      try { return section.subscribe(bump); } catch { return () => {}; }
    });
    return () => { for (const stop of stops) stop(); };
  }, [theaterSections, state.objectiveRecordSearchOpen, desktopView]);
  // 섹션 행은 데스크톱 배치에서만 선다 — 폰은 사령관 목적지가 따로 있다.
  const sectionEntries = useMemo(
    () => state.objectiveRecordSearchOpen && desktopView ? buildTheaterSectionSearchEntries(state.theaters, theaterSections, language) : [],
    [state.objectiveRecordSearchOpen, state.theaters, theaterSections, language, desktopView, sectionVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const filteredSections = useMemo(
    () => mode === "objectiveRecords" ? filterTheaterSectionSearchEntries(sectionEntries, text, getViewedTheaterId()) : [],
    [sectionEntries, mode, text, getViewedTheaterId()],
  );
  const groups = useMemo(
    () => groupObjectiveSearchEntries(filteredEntries, getViewedTheaterId(), filteredSections),
    [filteredEntries, filteredSections, getViewedTheaterId()],
  );
  // 검색 모드 주 목록의 렌더 순서 — 선택·키보드·스크롤이 모두 이 배열의 index를 쓴다.
  const primaryRows = useMemo<readonly PrimaryRow[]>(
    () => groups.flatMap((group) => [
      ...group.sections.map((section): PrimaryRow => ({ kind: "section", section, key: sectionResultKey(section.key) })),
      ...group.entries.map((entry): PrimaryRow => ({ kind: "objectiveRecord", entry, key: objectiveRecordResultKey(entry.objectiveId) })),
    ]),
    [groups],
  );
  const primaryIndexByKey = useMemo(() => new Map(primaryRows.map((row, index) => [row.key, index])), [primaryRows]);
  const undoAvailable = useMemo(() => canUndoLastClose?.() === true, [state.objectiveRecordSearchOpen, canUndoLastClose]);
  const undoKind = useMemo(() => lastUndoKind?.() ?? null, [state.objectiveRecordSearchOpen, lastUndoKind]);
  const commands = useMemo(
    () => buildPaletteCommands(state, railPanels, t, {
      canUndoLastClose: undoAvailable,
      undoKind,
      theaterSections: sectionEntries.map((section) => ({ theaterId: section.theaterId, sectionId: section.sectionId, pageId: section.pageId, titles: section.titles, icon: section.icon })),
    }),
    [state, railPanels, t, undoAvailable, undoKind, sectionEntries],
  );
  const recentCommandIds = useMemo(() => readRecentCommandIds(), [state.objectiveRecordSearchOpen]);
  const commandSections = useMemo<readonly { readonly id: "recent" | PaletteCommandGroup | "matches"; readonly commands: readonly ScoredPaletteCommand[] }[]>(() => {
    if (mode !== "commands") return [];
    if (searchTokens(text).length === 0) {
      return groupPaletteCommands(commands, recentCommandIds).map((section) => ({
        id: section.id,
        commands: section.commands.map((command) => ({ command, score: 0, exactTokens: 0, matchedIndices: [] })),
      }));
    }
    return [{ id: "matches", commands: matchPaletteCommands(commands, text) }];
  }, [mode, commands, recentCommandIds, text]);
  // 같은 명령이 최근 구역과 자기 구역에 함께 설 수 있다 — 선택·스크롤 키는 구역까지 담아 둘을 가른다.
  const commandRows = useMemo(
    () => commandSections.flatMap((section) => section.commands.map((scored) => ({ scored, key: commandResultKey(scored.command.commandId) + (section.id === "recent" ? ":recent" : "") }))),
    [commandSections],
  );
  const matchedCommands = useMemo(() => commandRows.map((row) => row.scored), [commandRows]);
  const tokens = useMemo(() => searchTokens(text), [text]);
  const railSearchEntries = useMemo(
    // info 행(상한 표식 등)은 표시만 하고 키보드 이동·활성화 대상에서는 뺀다.
    () => railSearchGroups.flatMap((group) => group.results.filter((result) => result.kind !== "info").map((result) => ({ group, result }))).sort((a, b) => Number(b.result.exact === true) - Number(a.result.exact === true)),
    [railSearchGroups],
  );
  const exactCount = railSearchEntries.filter((entry) => entry.result.exact === true).length;
  const primaryCount = mode === "objectiveRecords" ? primaryRows.length : matchedCommands.length;
  const resultCount = primaryCount + railSearchEntries.length;
  const clampedSelectedIndex = clampIndex(selectedIndex, resultCount);
  const primaryIndex = clampedSelectedIndex - exactCount;
  const selectedRailIndex = clampedSelectedIndex < exactCount ? clampedSelectedIndex : clampedSelectedIndex - primaryCount;
  const selectedResultKey = (() => {
    if (primaryIndex >= 0 && primaryIndex < primaryCount) {
      if (mode === "objectiveRecords") return primaryRows[primaryIndex]!.key;
      return commandRows[primaryIndex]!.key;
    }
    const rail = railSearchEntries[selectedRailIndex];
    return rail ? railResultKey(rail.group.panelId, rail.result.id) : undefined;
  })();
  const activeOptionId = selectedResultKey === undefined ? undefined : resultOptionId(selectedResultKey);
  const selectedPrimaryRow = mode === "objectiveRecords" && primaryIndex >= 0 ? primaryRows[primaryIndex] ?? null : null;
  // 동작 띠(→)는 Objective 행에만 선다 — 섹션 행은 여는 일 하나뿐이다.
  const selectedObjective = selectedPrimaryRow?.kind === "objectiveRecord" ? selectedPrimaryRow.entry : null;
  // 탭·범례·힌트의 조합 표기는 등록부의 현재 값이다 — 재배정이 바뀌면 함께 바뀐다.
  useShortcutOverrides();
  const searchShortcut = shortcutCommandLabel("console.search-objectiveRecords");
  const paletteShortcut = shortcutCommandLabel("console.command-palette");
  const undoShortcut = shortcutCommandLabel("console.undo-close");

  // 패널 내용 검색은 Objective 모드에서만 — 명령 모드는 명령만 보여 주는 편이 손에 맞는다.
  useEffect(() => {
    const generation = ++searchGenerationRef.current;
    setRailSearchGroups([]);
    const theaterId = getViewedTheaterId();
    if (!state.objectiveRecordSearchOpen || text.trim() === "" || !theaterId || mode !== "objectiveRecords") return;

    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void searchRailPanels(railPanels, text, theaterId, abort.signal).then((nextGroups) => {
        // provider가 abort를 무시해도 이전 세대 결과는 현재 팔레트에 반영하지 않는다.
        if (abort.signal.aborted || generation !== searchGenerationRef.current) return;
        setRailSearchGroups(nextGroups);
      });
    }, RAIL_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [mode, text, railPanels, getViewedTheaterId(), state.objectiveRecordSearchOpen, t]);

  useEffect(() => {
    if (!state.objectiveRecordSearchOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [state.objectiveRecordSearchOpen]);

  // seed는 번호가 바뀔 때마다 반영한다 — 열린 창에서 ⌘P를 눌러도 명령 탭으로 옮겨 가야 한다.
  useEffect(() => {
    if (!state.objectiveRecordSearchOpen) {
      appliedSeedNonceRef.current = 0;
      setMode("objectiveRecords");
      setText("");
      setSelectedIndex(0);
      setActionsFor(null);
      return;
    }
    if (appliedSeedNonceRef.current === state.objectiveRecordSearchSeedNonce) return;
    appliedSeedNonceRef.current = state.objectiveRecordSearchSeedNonce;
    const seed = parsePaletteSeed(state.objectiveRecordSearchSeed);
    setMode(seed.mode);
    setText(seed.text);
    setSelectedIndex(0);
    setActionsFor(null);
    inputRef.current?.focus();
  }, [state.objectiveRecordSearchOpen, state.objectiveRecordSearchSeed, state.objectiveRecordSearchSeedNonce]);

  useEffect(() => {
    setObjectiveSearchMode(state.objectiveRecordSearchOpen ? mode : null);
  }, [mode, state.objectiveRecordSearchOpen]);

  useEffect(() => {
    setSelectedIndex(0);
    setActionsFor(null);
  }, [mode, text]);

  useEffect(() => {
    if (!state.objectiveRecordSearchOpen || selectedResultKey === undefined) return;
    resultRefs.current.get(selectedResultKey)?.scrollIntoView({ block: "nearest" });
  }, [selectedResultKey, state.objectiveRecordSearchOpen]);

  if (!state.objectiveRecordSearchOpen) return null;

  const selectEntry = (objectiveId: string) => {
    if (entries.find((entry) => entry.objectiveId === objectiveId)?.archived) {
      if (restoringArchive.current) return;
      restoringArchive.current = true;
      void restoreObjectiveCluster(objectiveId).then(async (result) => {
        const restoredIds = new Set(result.objectiveRecords.map((node) => node.id));
        hydrateObjectiveRecords([...getState().objectiveRecords.filter((node) => !restoredIds.has(node.id)), ...result.objectiveRecords]);
        await fetchObjectiveRecords(null).then(hydrateObjectiveRecords).catch(() => {});
        previousFocusRef.current = null;
        if (!openRestoredObjective(result.rootObjectiveId)) throw new Error("restore_failed");
        // focusObjective의 일반 열기 경로는 자동 재개할 수 있다. 보관 복원은 휴면 상태만 표시한다.
        navigate("/objectives"); closeObjectiveSearch(); void refreshObjectiveArchive();
      }).catch(() => { setArchiveNotice(true); void refreshObjectiveArchive(); }).finally(() => { restoringArchive.current = false; });
      return;
    }
    // 선택은 대상 Objective으로 키보드 포커스를 넘기므로 닫힘 cleanup이 이전 UI 포커스를 되찾지 않게 한다.
    previousFocusRef.current = null;
    // 최대화 해제는 이동 경로(objectiveRecords.tsx의 pendingObjectiveFocus 소비)에 위임한다 — 최대화 중이면 유지·교체.
    focusObjective(objectiveId);
    navigate("/objectives");
    closeObjectiveSearch();
  };

  const selectRailResult = async (panelId: string, result: PaneSearchResult) => {
    // activate가 plugin-local 논리 타깃을 먼저 기록한 뒤에만 host route/rail을 연다.
    let target: PaneTarget | void;
    try {
      target = await result.activate();
    } catch {
      return;
    }
    previousFocusRef.current = null;
    if (target) {
      landPaneTarget(target, createHostPaneTargetPorts(railBindings), panelId);
    } else {
      navigate({ pathname: "/objectives", search: window.location.search });
      // 페인을 세우지 않는 엔트리는 레일 패널을 열 수 없다 — 그 엔트리가 여는 것은 표면이다.
      // 여기서 갈라 주지 않으면 팔레트로 고른 결과가 아무 데도 착지하지 않는다.
      const surfaceId = railPanels.find((panel) => panel.id === panelId)?.surfaceId;
      if (surfaceId) openExpandedSurface({ surfaceId });
      else presentRailPanel(panelId);
    }
    closeObjectiveSearch();
    if (panelId === "global-shell") {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".global-shell-mount .xterm-helper-textarea")?.focus({ preventScroll: true }));
    }
  };

  const runAction = (action: PaletteCommandAction, current: boolean) => {
    switch (action.kind) {
      case "undo-close": {
        previousFocusRef.current = null;
        if (canUndoLastClose?.()) onUndoLastClose?.();
        break;
      }
      case "switch-theater": {
        if (current) break;
        // Theater 전환은 대화 화면으로 포커스 문맥을 넘기므로 selectEntry처럼 이전 포커스 복원을 억제한다.
        previousFocusRef.current = null;
        closeConversationSurface();
        // 사이드바 Theater 머리처럼 누르는 순간 기여의 첫 칸을 읽고, 없으면 폰에서도 시스템 프롬프트로 간다.
        const landing = resolveTheaterInboxLanding(registry.theaterContributions, action.theaterId);
        openTheaterInbox({ theaterId: action.theaterId, ...(landing ?? { sectionId: "console:settings", pageId: "system-prompt" }) });
        navigate("/objectives");
        break;
      }
      case "open-theater-section": {
        // 사이드바 Theater 머리와 같은 길 — 가운데 대화는 섹션의 openConversation이 갈아 끼우므로 대화 화면을 닫지 않는다.
        // 다른 Theater면 이 요청이 Theater 전환도 겸한다(보고 있는 Theater가 Inbox를 따른다).
        previousFocusRef.current = null;
        openTheaterInbox({ theaterId: action.theaterId, sectionId: action.sectionId, pageId: action.pageId, returnFocus: null });
        if (!location.pathname.startsWith("/objectives")) navigate("/objectives");
        break;
      }
      case "new-theater": {
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/objectives")) navigate("/objectives");
        requestSideBarAddTheater();
        break;
      }
      case "new-objectiveRecord": {
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/objectives")) navigate("/objectives");
        // 사이드바 맨 위 「+」와 같은 길 — 새 세션 화면을 본문에 연다(Theater 기본 규칙은 new-session-entry).
        openDefaultNewSession();
        break;
      }
      case "resume-objectiveRecord": {
        // plugin이 resumeObjective 훅을 제공하면 직접 재개하고, 미제공 시에만 프레임 포커스로 폭백한다.
        // 실패 시에는 포커스하지 않는다 — focusObjective은 알림을 제거하므로(store.ts) plugin이 emit한
        // agent.resume-failed가 지워져 침묵 실패가 된다. 실패 피드백은 칩 뱃지 + Alerts 항목이 담당한다.
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/objectives")) navigate("/objectives");
        resumeObjectiveInPlace(action.objectiveId, state.objectiveRecords, plugins, focusObjective);
        break;
      }
      case "archive-objectiveRecord": {
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/objectives")) navigate("/objectives");
        void archiveObjectiveFromUi(action.objectiveId).then((outcome) => { if (outcome) onArchived?.(outcome); });
        break;
      }
      case "open-archive": {
        previousFocusRef.current = null;
        openArchiveSheet();
        break;
      }
      case "toggle-status-axis": {
        if (!location.pathname.startsWith("/objectives")) navigate("/objectives");
        toggleTheaterStatusAxis(getViewedTheaterId());
        break;
      }
      case "open-rail-panel": {
        // rail·사이드바는 objectiveRecords 페이지에만 마운트되므로 다른 경로에서는 먼저 이동한다.
        if (!location.pathname.startsWith("/objectives")) navigate("/objectives");
        if (action.surfaceId) openExpandedSurface({ surfaceId: action.surfaceId });
        else presentRailPanel(action.panelId);
            break;
      }
      case "switch-theme": {
        if (current) break;
        const previousTheme = state.activeTheme;
        setActiveTheme(action.theme);
        void setGlobalSettingsField("theme", action.theme).then((saved) => {
          if (!saved) setActiveTheme(previousTheme);
        });
        break;
      }
      case "open-settings": {
        // 폰의 설정은 /settings 페이지다.
        if (getViewModeSnapshot().effective === "mobile") {
          previousFocusRef.current = null;
          navigate("/settings");
          break;
        }
        // 데스크톱 설정은 라우트가 아니라 가운데 모달이다 — 모달이 마운트하며 포커스를 가져가므로 복원을 억제한다.
        previousFocusRef.current = null;
        // 모달은 /objectives에만 선다. 주소 쿼리는 selectRailResult와 같은 이유로 지킨다.
        if (!location.pathname.startsWith("/objectives")) navigate({ pathname: "/objectives", search: window.location.search });
        openSettingsSurface();
        break;
      }
      case "open-keyboard-shortcuts": {
        // 팔레트가 닫히면서 다이얼로그가 열리므로, App 캡처 시점의 activeElement는 제거 중인 팔레트 내부다.
        // 팔레트를 연 시점의 요소를 채널로 넘겨 다이얼로그 닫힘 시 그 요소로 복원되게 한다.
        stashKeyboardShortcutsReturnFocus(previousFocusRef.current);
        previousFocusRef.current = null;
        openKeyboardShortcuts();
        break;
      }
      case "rename-objectiveRecord":
      case "assign-objective-group":
      case "set-objective-accent": {
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/objectives")) navigate("/objectives");
        requestSideBarObjectiveAction(action.objectiveId, paletteActionToSideBarAction(action.kind));
        break;
      }
      case "whats-new": {
        openWhatsNew();
        break;
      }
      case "open-commissioning": {
        // 팔레트가 닫히면서 오버레이가 열리므로 오버레이가 보는 activeElement는 제거 중인 팔레트 내부다.
        // 팔레트를 연 시점의 요소를 채널로 넘겨 가이드가 닫힐 때 그 요소로 복원되게 한다.
        stashCommissioningReturnFocus(previousFocusRef.current);
        previousFocusRef.current = null;
        openOnboarding();
        break;
      }
    }
    closeObjectiveSearch();
  };

  const selectTheaterSection = (section: TheaterSectionSearchEntry) => {
    runAction({ kind: "open-theater-section", theaterId: section.theaterId, sectionId: section.sectionId, pageId: section.pageId }, false);
  };

  const runCommand = (command: PaletteCommandEntry) => {
    noteCommandRun(command.commandId);
    runAction(command.action, command.current);
  };

  // Objective 행의 동작 띠. 정의는 명령 팔레트의 액션과 같다 — 같은 일이 두 자리에 서도 한 경로로 간다.
  const rowActions = (entry: ObjectiveSearchEntry): readonly RowAction[] => {
    if (entry.archived) return [{ id: "restore-open", label: t("archive.searchRestoreOpen"), glyph: "objective-open", run: () => selectEntry(entry.objectiveId) }];
    const actions: RowAction[] = [
      { id: "open", label: t("chrome.objectiveRecordSearch.actionOpen"), glyph: "objective-open", run: () => selectEntry(entry.objectiveId) },
    ];
    if (entry.activity === "ended") {
      actions.push({ id: "resume", label: t("chrome.objectiveRecordSearch.actionResume"), glyph: "objective-resume", run: () => runAction({ kind: "resume-objectiveRecord", objectiveId: entry.objectiveId }, false) });
    }
    // 이름 변경은 사이드바가 소비하는 요청이다. 모바일 셸에는 사이드바가 없어 요청이 아무 데도
    // 닿지 않고 나중에 데스크톱 사이드바가 서면 뒤늦게 재생되므로, 그 표면에서는 띠에 올리지 않는다.
    if (getViewModeSnapshot().effective !== "mobile") {
      actions.push(
        { id: "rename", label: t("chrome.objectiveRecordSearch.actionRename"), glyph: "objective-rename", run: () => runAction({ kind: "rename-objectiveRecord", objectiveId: entry.objectiveId }, false) },
      );
    }
    actions.push({ id: "archive", label: t("chrome.objectiveRecordSearch.actionArchive"), glyph: "objective-archive", run: () => runAction({ kind: "archive-objectiveRecord", objectiveId: entry.objectiveId }, false) });
    return actions;
  };

  const activateSelected = () => {
    if (primaryIndex >= 0 && primaryIndex < primaryCount) {
      if (mode === "objectiveRecords") {
        const row = primaryRows[primaryIndex];
        if (!row) return;
        if (row.kind === "section") {
          selectTheaterSection(row.section);
          return;
        }
        const selected = row.entry;
        if (actionsFor === selected.objectiveId) rowActions(selected)[actionIndex]?.run();
        else selectEntry(selected.objectiveId);
        return;
      }
      const selected = matchedCommands[primaryIndex];
      if (selected) runCommand(selected.command);
      return;
    }
    const panelEntry = railSearchEntries[selectedRailIndex];
    if (panelEntry) void selectRailResult(panelEntry.group.panelId, panelEntry.result);
  };

  const switchMode = (next: PaletteMode) => {
    setMode(next);
    setText("");
    inputRef.current?.focus();
  };

  const handleInputChange = (value: string) => {
    // 접두 문법은 스위치를 모르는 손을 위한 것이다 — 빈 입력에 `>`로 시작하는 값이 들어오면(타자든
    // `>sidebar` 붙여넣기든) 명령 모드로 옮기고 접두 뒤를 질의로 남긴다.
    const prefixMode = text === "" && mode === "objectiveRecords" ? paletteModeForPrefix(value[0] ?? "") : null;
    if (prefixMode) {
      setMode(prefixMode);
      setText(value.slice(1));
      return;
    }
    setText(value);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    setNavigation("keyboard");
    if (event.key === "Escape") {
      event.preventDefault();
      if (actionsFor !== null) setActionsFor(null);
      else closeObjectiveSearch();
      return;
    }
    if (event.key === "Backspace" && text === "" && mode !== "objectiveRecords") {
      event.preventDefault();
      switchMode("objectiveRecords");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActionsFor(null);
      setSelectedIndex((current) => clampIndex(current + (event.key === "ArrowDown" ? 1 : -1), resultCount));
      return;
    }
    if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && selectedObjective) {
      const input = inputRef.current;
      // 캐럿이 글 가운데면 화살표는 글 편집이다 — 띠는 캐럿이 끝(→)·처음(←)에 있을 때만 받는다.
      const caretAtEdge = !input || (event.key === "ArrowRight" ? input.selectionEnd === input.value.length : input.selectionStart === 0);
      if (!caretAtEdge && actionsFor === null) return;
      event.preventDefault();
      const actions = rowActions(selectedObjective);
      if (event.key === "ArrowRight") {
        if (actionsFor === selectedObjective.objectiveId) setActionIndex((current) => Math.min(current + 1, actions.length - 1));
        else {
          setActionsFor(selectedObjective.objectiveId);
          setActionIndex(0);
        }
      } else if (actionsFor === selectedObjective.objectiveId) {
        if (actionIndex > 0) setActionIndex((current) => current - 1);
        else setActionsFor(null);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activateSelected();
      return;
    }
    if (event.key === "Tab") trapFocus(event, cardRef.current);
  };

  const placeholder = t(mode === "commands" ? "chrome.objectiveRecordSearch.placeholderCommands" : "chrome.objectiveRecordSearch.placeholderObjectiveRecords");
  const emptyMessage = t(mode === "commands" ? "chrome.objectiveRecordSearch.noMatchingCommands" : "chrome.objectiveRecordSearch.noMatching");
  const sectionTitle = (id: "recent" | PaletteCommandGroup | "matches"): string => {
    switch (id) {
      case "recent": return t("chrome.objectiveRecordSearch.sectionRecent");
      case "current-objectiveRecord": {
        const active = state.objectiveRecords.find((objectiveRecord) => objectiveRecord.id === state.activeObjectiveId);
        return active ? `${t("chrome.objectiveRecordSearch.sectionCurrentObjective")} · ${active.title}` : t("chrome.objectiveRecordSearch.sectionCurrentObjective");
      }
      case "theater": return t("chrome.objectiveRecordSearch.sectionTheater");
      case "view": return t("chrome.objectiveRecordSearch.sectionView");
      case "panel": return t("chrome.objectiveRecordSearch.sectionPanel");
      case "console": return t("chrome.objectiveRecordSearch.sectionConsole");
      case "matches": return t("chrome.objectiveRecordSearch.commands");
    }
  };

  const renderRailGroups = (exact: boolean) => railSearchGroups.map((group) => {
    const results = group.results.filter((result) => (result.exact === true) === exact);
    if (results.length === 0) return null;
    const headingId = railGroupHeadingId(group.panelId) + (exact ? "-exact" : "");
    const panelIcon = railPanels.find((panel) => panel.id === group.panelId)?.icon;
    return (
      <section className="objective-search-section objective-search-panel-section" key={headingId} role="group" aria-labelledby={headingId}>
        <h2 id={headingId} className="objective-search-section-heading">{group.panelTitle}</h2>
        {results.map((result) => {
          const railIndex = railSearchEntries.findIndex((entry) => entry.group.panelId === group.panelId && entry.result === result);
          const index = railIndex < exactCount ? railIndex : primaryCount + railIndex;
          const active = index === clampedSelectedIndex;
          const resultKey = railResultKey(group.panelId, result.id);
          if (result.kind === "info") {
            // 읽기 전용 표식 행 — option 역할·활성화·"열기" 어포던스를 모두 붙이지 않는다.
            return (
              <div key={result.id} className="objective-search-result objective-search-panel-info">
                <span className="objective-search-result-text objective-search-result-text-inline">
                  <strong>{highlightText(result.title, tokens)}</strong>
                  {panelSubtitle(result) ? <small>{highlightText(panelSubtitle(result)!, tokens)}</small> : null}
                </span>
              </div>
            );
          }
          return (
            <button
              id={resultOptionId(resultKey)}
              key={result.id}
              ref={(node) => {
                if (node) resultRefs.current.set(resultKey, node);
                else resultRefs.current.delete(resultKey);
              }}
              type="button"
              className={`objective-search-result objective-search-panel-result ${active ? "is-active" : ""}`}
              role="option"
              aria-selected={active}
              onMouseEnter={() => { setNavigation("pointer"); setSelectedIndex(index); }}
              onClick={() => { void selectRailResult(group.panelId, result); }}
            >
              <PaletteRailIcon icon={result.icon ?? panelIcon} />
              {/* 패널 결과도 한 줄이다 — 부제(경로·태그)는 제목 오른쪽에 조용한 메타로 서고,
                  제목과 같은 부제(파일명 = 상대 경로)는 반복하지 않는다. */}
              <span className="objective-search-result-text objective-search-result-text-inline">
                <strong>{highlightText(result.title, tokens)}</strong>
                {panelSubtitle(result) ? <small>{highlightText(panelSubtitle(result)!, tokens)}</small> : null}
              </span>
              <span className="objective-search-panel-open">{t("chrome.objectiveRecordSearch.open")}</span>
            </button>
          );
        })}
      </section>
    );
  });

  // info 행만 돌아온 패널 결과(상한 표식 등)는 선택 대상은 아니어도 보여야 한다 — 감추면 「검색이
  // 끝까지 가지 못했다」는 표식이 「일치 없음」으로 둔갑한다.
  const hasResults = resultCount > 0 || railSearchGroups.length > 0;

  return (
    <div className="objective-search-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeObjectiveSearch();
    }}>
      <section
        ref={cardRef}
        className="objective-search-card"
        role="dialog"
        aria-modal="true"
        aria-label={commandMode ? t("chrome.objectiveRecordSearch.commandsDialog") : t("chrome.objectiveRecordSearch.quickSearchDialog")}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="objective-search-field">
          <SearchIcon />
          <input
            ref={inputRef}
            id="objective-search-input"
            type="search"
            value={text}
            onChange={(event) => handleInputChange(event.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            role="combobox"
            aria-expanded={true}
            aria-controls={LISTBOX_ID}
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            spellCheck={false}
          />
          {/* 모드 스위치 — 검색창 오른쪽의 두 칸. ⌘K/⌘P가 같은 두 칸을 오간다. */}
          <div className="objective-search-switch" role="tablist" aria-label={t("chrome.objectiveRecordSearch.switchAria")}>
            {PALETTE_MODES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                className={`objective-search-switch-option${candidate === mode ? " is-active" : ""}`}
                aria-selected={candidate === mode}
                tabIndex={-1}
                title={candidate === "objectiveRecords" ? searchShortcut : paletteShortcut}
                onClick={() => switchMode(candidate)}
              >
                {t(candidate === "objectiveRecords" ? "chrome.objectiveRecordSearch.tabObjectiveRecords" : "chrome.objectiveRecordSearch.tabCommands")}
                <kbd>{candidate === "objectiveRecords" ? searchShortcut : paletteShortcut}</kbd>
              </button>
            ))}
          </div>
        </div>
        <div id={LISTBOX_ID} className="objective-search-results" data-nav={navigation} role="listbox" aria-label={commandMode ? t("chrome.objectiveRecordSearch.commandResults") : t("chrome.objectiveRecordSearch.objectiveRecordResults")}>
          {!hasResults ? (
            <p className="objective-search-empty">
              {emptyMessage}
              {mode === "objectiveRecords" ? <span className="objective-search-empty-hint">{t("chrome.objectiveRecordSearch.noMatchingObjectiveRecordsHint", { shortcut: paletteShortcut })}</span> : null}
            </p>
          ) : mode !== "objectiveRecords" ? (
            <>
              {commandSections.map((section) => {
                const headingId = commandSectionHeadingId(section.id);
                return (
                  <section className="objective-search-section" key={section.id} role="group" aria-labelledby={headingId}>
                    <h2 id={headingId} className="objective-search-section-heading">
                      {section.id !== "matches" ? <PaletteSectionGlyph section={section.id} /> : null}
                      {sectionTitle(section.id)}
                    </h2>
                    {section.commands.map((scored) => {
                      const { command } = scored;
                      const index = matchedCommands.indexOf(scored);
                      const active = index === clampedSelectedIndex;
                      const resultKey = commandRows[index]!.key;
                      return (
                        <button
                          id={resultOptionId(resultKey)}
                          key={resultKey}
                          ref={(node) => {
                            if (node) resultRefs.current.set(resultKey, node);
                            else resultRefs.current.delete(resultKey);
                          }}
                          type="button"
                          className={`objective-search-result${active ? " is-active" : ""}${command.danger ? " is-danger" : ""}`}
                          role="option"
                          aria-selected={active}
                          onMouseEnter={() => { setNavigation("pointer"); setSelectedIndex(index); }}
                          onClick={() => runCommand(command)}
                        >
                          <PaletteCommandGlyph command={command} />
                          <span className="objective-search-result-text">
                            <strong>{highlightIndices(command.label, scored.matchedIndices)}</strong>
                          </span>
                          {command.current ? <span className="objective-search-theater">{t("chrome.objectiveRecordSearch.current")}</span> : null}
                          {command.undoable ? <span className="objective-search-undoable">{t("chrome.objectiveRecordSearch.undoable", { shortcut: undoShortcut })}</span> : null}
                          {command.shortcut ? <span className="objective-search-shortcut">{chordKeyLabels(resolveShortcutChords(command.shortcut)[0] ?? "").map((key, keyIndex) => <kbd key={`${keyIndex}:${key}`}>{key}</kbd>)}</span> : null}
                        </button>
                      );
                    })}
                  </section>
                );
              })}
              {renderRailGroups(false)}
            </>
          ) : (
            <>
              {renderRailGroups(true)}
              {groups.map((group) => {
                const headingId = objectiveRecordGroupHeadingId(group.theaterId) + (group.archived ? "-archived" : "");
                const activeGroup = !group.archived && group.theaterId === getViewedTheaterId();
                return (
                  <section className="objective-search-section" key={`${group.archived ? "archive:" : "active:"}${group.theaterId ?? UNASSIGNED_GROUP_KEY}`} role="group" aria-labelledby={headingId}>
                    {/* 사이드바 머리처럼 별칭을 앞세우고 원래 이름을 곁에 둔다. */}
                    <h2 id={headingId} className="objective-search-section-heading">
                      {highlightText(group.theaterAlias ?? group.theaterLabel, tokens)}
                      {group.theaterAlias ? <span className="objective-search-section-note">{highlightText(group.theaterLabel, tokens)}</span> : null}
                      {activeGroup ? <span className="objective-search-section-note">{t("chrome.objectiveRecordSearch.current")}</span> : null}
                    </h2>
                    {group.sections.map((section) => {
                      const resultKey = sectionResultKey(section.key);
                      const index = exactCount + (primaryIndexByKey.get(resultKey) ?? 0);
                      const active = index === clampedSelectedIndex;
                      return (
                        <button
                          id={resultOptionId(resultKey)}
                          key={resultKey}
                          ref={(node) => {
                            if (node) resultRefs.current.set(resultKey, node);
                            else resultRefs.current.delete(resultKey);
                          }}
                          type="button"
                          className={`objective-search-result objective-search-panel-result ${active ? "is-active" : ""}`}
                          role="option"
                          aria-selected={active}
                          onMouseEnter={() => { setNavigation("pointer"); setSelectedIndex(index); }}
                          onClick={() => selectTheaterSection(section)}
                        >
                          <PaletteRailIcon icon={section.icon} />
                          <span className="objective-search-result-text objective-search-result-text-inline">
                            <strong>{highlightText(section.title, tokens)}</strong>
                            {section.caption ? <small>{highlightText(section.caption, tokens)}</small> : null}
                          </span>
                          <span className="objective-search-panel-open">{t("chrome.objectiveRecordSearch.open")}</span>
                        </button>
                      );
                    })}
                    {group.entries.map((entry) => {
                      const index = exactCount + (primaryIndexByKey.get(objectiveRecordResultKey(entry.objectiveId)) ?? 0);
                      const active = index === clampedSelectedIndex;
                      const resultKey = objectiveRecordResultKey(entry.objectiveId);
                      const stripOpen = actionsFor === entry.objectiveId;
                      const actions = stripOpen ? rowActions(entry) : [];
                      const workspace = visibleWorkspace(sessions[entry.objectiveId]?.workspace);
                      return (
                        <div key={entry.objectiveId} className={`objective-search-row${stripOpen ? " has-actions" : ""}`}>
                          <button
                            id={resultOptionId(resultKey)}
                            ref={(node) => {
                              if (node) resultRefs.current.set(resultKey, node);
                              else resultRefs.current.delete(resultKey);
                            }}
                            type="button"
                            className={`objective-search-result ${active ? "is-active" : ""}`}
                            role="option"
                            aria-selected={active}
                            onMouseEnter={() => { setNavigation("pointer"); setSelectedIndex(index); }}
                            onClick={() => selectEntry(entry.objectiveId)}
                          >
                            {/* 이름 왼쪽 슬롯은 사이드바 칩과 같은 활동 상태 소유다(Shell만 종류 글리프).
                                마크가 항상 서므로 제목 열이 어긋나지 않는다. 공급자·Theater는 행에 반복하지
                                않는다 — Theater는 구역 머리글이, 공급자는 사이드바가 이미 말한다. */}
                            <span className="objective-search-op-mark">
                              <ObjectiveNameMark
                                objectiveRecord={{ id: entry.objectiveId, parentObjectiveId: entry.parentObjectiveId }}
                                archived={entry.archived}
                                status={resolveObjectiveMarkVisual({ activity: entry.activity, objectiveId: entry.objectiveId, idleArrivalIds })}
                              />
                            </span>
                            {/* "지금 어디"는 실험 기능이 켜진 동안만 오는 서버 투영이다. 팔레트는
                                한 줄 행을 지키려고 이름 옆 같은 줄에 붙이고, 접근성 이름에는 숨은 문장으로 덧붙인다 — aria-label로
                                덮으면 활동 마크(실행 중·대기 등)의 이름까지 지워지므로 자손 텍스트로 남긴다. */}
                            <span className={`objective-search-result-text${workspace ? " objective-search-result-text-inline" : ""}`}>
                              <strong>{highlightText(entry.objectiveRecordName, tokens)}</strong>
                              {workspace ? <ObjectiveWorkspaceContext workspace={workspace} /> : null}
                              {workspace ? <span className="objective-search-sr-only">{describeWorkspace(t, workspace)}</span> : null}
                            </span>
                            {entry.archived ? <span className="objective-search-archived">{t("archive.searchArchived")}</span> : null}
                            <span className="objective-search-row-arrow" aria-hidden="true">{stripOpen ? "◂" : "▸"}</span>
                          </button>
                          {stripOpen ? (
                            <div className="objective-search-actions" role="group" aria-label={t("chrome.objectiveRecordSearch.actionsAria", { title: entry.objectiveRecordName })}>
                              {actions.map((action, i) => (
                                <button
                                  key={action.id}
                                  type="button"
                                  tabIndex={-1}
                                  className={`objective-search-action${i === actionIndex ? " is-active" : ""}${action.danger ? " is-danger" : ""}`}
                                  onMouseEnter={() => { setNavigation("pointer"); setActionIndex(i); }}
                                  onClick={action.run}
                                >
                                  <PaletteActionGlyph glyph={action.glyph} />
                                  {action.label}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </section>
                );
              })}
              {renderRailGroups(false)}
            </>
          )}
        </div>
        {shellNotice ? <p className="archive-sheet-notice" role="alert">{shellNotice}</p> : null}
        {archiveNotice ? <p className="archive-sheet-notice" role="status">{t("archive.notice.restoreFailed")}</p> : null}
        <div className="objective-search-legend">
          <span><kbd>↑</kbd><kbd>↓</kbd>{t("chrome.objectiveRecordSearch.legendMove")}</span>
          <span><kbd>↵</kbd>{t(mode === "objectiveRecords" ? "chrome.objectiveRecordSearch.legendOpen" : "chrome.objectiveRecordSearch.legendRun")}</span>
          {mode === "objectiveRecords" ? <span><kbd>→</kbd>{t("chrome.objectiveRecordSearch.legendActions")}</span> : null}
          <span><kbd>esc</kbd>{t("chrome.objectiveRecordSearch.legendClose")}</span>
          <span className="objective-search-legend-switch">{t(mode === "objectiveRecords" ? "chrome.objectiveRecordSearch.legendToCommands" : "chrome.objectiveRecordSearch.legendToObjectiveRecords", { shortcut: mode === "objectiveRecords" ? paletteShortcut : searchShortcut })}</span>
        </div>
      </section>
    </div>
  );
}

type PrimaryRow =
  | { readonly kind: "section"; readonly section: TheaterSectionSearchEntry; readonly key: string }
  | { readonly kind: "objectiveRecord"; readonly entry: ObjectiveSearchEntry; readonly key: string };

interface RowAction {
  readonly id: string;
  readonly label: string;
  readonly glyph: "objective-open" | "objective-resume" | "objective-rename" | "objective-archive";
  readonly danger?: boolean;
  readonly run: () => void;
}

function commandSectionHeadingId(id: string): string {
  return `objective-search-heading-commands-${domIdPart(id)}`;
}

function paletteActionToSideBarAction(
  kind: "rename-objectiveRecord" | "assign-objective-group" | "set-objective-accent",
): SideBarObjectiveAction {
  switch (kind) {
    case "rename-objectiveRecord": return "rename";
    case "assign-objective-group": return "assign-group";
    case "set-objective-accent": return "set-accent";
  }
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function panelSubtitle(result: { readonly title: string; readonly subtitle?: string | null }): string | null {
  const subtitle = result.subtitle?.trim();
  return subtitle && subtitle !== result.title.trim() ? subtitle : null;
}

function objectiveRecordGroupHeadingId(theaterId: string | null): string {
  return `objective-search-heading-${domIdPart(theaterId ?? UNASSIGNED_GROUP_KEY)}`;
}

function commandOptionId(commandId: string): string {
  return resultOptionId(commandResultKey(commandId));
}

function resultOptionId(resultKey: string): string {
  return `objective-search-option-${domIdPart(resultKey)}`;
}

function objectiveRecordResultKey(objectiveId: string): string {
  return `objectiveRecord:${objectiveId}`;
}

function sectionResultKey(sectionKey: string): string {
  return `section:${sectionKey}`;
}

function commandResultKey(commandId: string): string {
  return `command:${commandId}`;
}

function railResultKey(panelId: string, resultId: string): string {
  return `panel:${panelId}:${resultId}`;
}

function railGroupHeadingId(panelId: string): string {
  return `objective-search-heading-panel-${domIdPart(panelId)}`;
}

function domIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function highlightText(text: string, tokens: readonly string[]): ReactNode {
  if (tokens.length === 0) return text;
  const segments: ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const match = findNextToken(text, tokens, cursor);
    if (!match) {
      segments.push(text.slice(cursor));
      break;
    }
    if (match.start > cursor) segments.push(text.slice(cursor, match.start));
    segments.push(<mark key={`${match.start}-${match.end}`}>{text.slice(match.start, match.end)}</mark>);
    cursor = match.end;
  }
  return segments;
}

function highlightIndices(text: string, indices: readonly number[]): ReactNode {
  if (indices.length === 0) return text;
  const segments: ReactNode[] = [];
  let cursor = 0;
  let runStart = indices[0]!;
  let runEnd = runStart + 1;

  for (let index = 1; index <= indices.length; index += 1) {
    const matchedIndex = indices[index];
    if (matchedIndex === runEnd) {
      runEnd += 1;
      continue;
    }
    if (runStart > cursor) segments.push(text.slice(cursor, runStart));
    segments.push(<mark key={`${runStart}-${runEnd}`}>{text.slice(runStart, runEnd)}</mark>);
    cursor = runEnd;
    if (matchedIndex !== undefined) {
      runStart = matchedIndex;
      runEnd = matchedIndex + 1;
    }
  }
  if (cursor < text.length) segments.push(text.slice(cursor));
  return segments;
}

function findNextToken(text: string, tokens: readonly string[], startAt: number): { readonly start: number; readonly end: number } | null {
  const lowerText = text.toLocaleLowerCase();
  let best: { readonly start: number; readonly end: number } | null = null;
  for (const token of tokens) {
    const start = lowerText.indexOf(token, startAt);
    if (start === -1) continue;
    if (!best || start < best.start) best = { start, end: start + token.length };
  }
  return best;
}

function trapFocus(event: ReactKeyboardEvent<HTMLElement>, card: HTMLElement | null): void {
  if (!card) return;
  const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => element.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
    return;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m14.2 14.2 3 3M8.9 15.2a6.3 6.3 0 1 1 0-12.6 6.3 6.3 0 0 1 0 12.6Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
