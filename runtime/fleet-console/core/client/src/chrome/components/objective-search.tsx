import { ChevronGlyph } from "@fleet-console/ui/react";
import { closeConversationSurface } from "../../../../../features/workspace/client/conversation/conversation-surface-store.js";
import { openTheaterInbox } from "../../../../../features/workspace/client/theater-inbox/store.js";
import { resolveTheaterInboxLanding } from "../../../../../features/workspace/client/theater-contributions.js";
import { useFeatureRegistry } from "../../integration/feature-registry.js";
import { openDefaultNewSession } from "../../../../../features/workspace/client/conversation/new-session-entry.js";
import { getViewedCommodoreId, getViewedTheaterId, useViewedCommodoreId } from "../../integration/viewed-theater.js";
import { requestCommodoreCreate } from "../../../../../features/commodore/client/commodore-create-modal.js";
import { useCommodoreList, setZoneCommodore, selectMobileCommodore, useZoneCommodore } from "../../../../../features/commodore/client/commodore-list.js";
import { useHostCapabilities } from "../../integration/use-host-capabilities.js";
import { landPaneTarget } from "../pane/pane-target.js";
import { createHostPaneTargetPorts } from "../../integration/feature-capabilities.js";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { ClientFeatureDescriptor } from "../../../../../features/workspace/shared/feature-surfaces.js";
import type { PaneSearchResult, PaneTarget } from "../../../../../features/workspace/shared/pane.js";
import { openExpandedSurface } from "../expanded-surface/store.js";
import { useDesktopRailEntries } from "../pane/pane-registry.js";
import type { RailPanelDescriptor, RailSearchResult } from "../../../../../features/workspace/shared/rail.js";
import type { TheaterInboxSectionDescriptor } from "../../../../../features/workspace/shared/theater-inbox.js";

import { ObjectiveNameMark } from "../../../../../features/execution/client/components/objective-name-mark.js";
import { ObjectiveAvatar } from "../../../../../features/workspace/client/avatars.js";
import { CommodoreAvatar } from "../../../../../features/commodore/client/commodore-avatar.js";
import { setGlobalSettingsField } from "../../../../../features/settings/client/global-settings-store.js";
import {
  buildTheaterSectionSearchEntries,
  groupCommodorePaletteEntries,
  parsePaletteSeed,
  RAIL_SEARCH_DEBOUNCE_MS,
  searchRailPanels,
  searchTokens,
  type CommodorePaletteGroup,
  type ObjectiveSearchEntry,
  type PaletteSearchPanel,
  type RailSearchGroup,
} from "../../integration/objective-search.js";
import { noteCommandRun, readRecentCommandIds, recentObjectiveRank } from "../../integration/palette-recent.js";
import { PaletteActionGlyph, PaletteCommandGlyph, PaletteRailIcon } from "./palette-glyphs.js";
import { resolveObjectiveActivity, resolveObjectiveDisplayActivity, resolveObjectiveMarkVisual } from "../../../../../features/execution/client/objective-activity.js";
import { useObjectiveClusters } from "../../../../../features/workspace/client/objective-clusters.js";
import { CONVERSATION_ROW_PHRASE } from "../../../../../features/workspace/client/sidebar/side-bar-row-style.js";
import { archiveObjectiveFromUi, resumeObjectiveInPlace, type ArchiveOutcome } from "../../integration/objective-actions.js";
import { openArchiveSheet } from "../../integration/objective-archive.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../../../features/execution/client/objective-marks.js";
import {
  buildPaletteCommands,
  commandModeQuery,
  groupPaletteCommands,
  isCommandModeInput,
  matchPaletteCommands,
  type PaletteCommandAction,
  type PaletteCommandEntry,
  type PaletteCommandGroup,
  type ScoredPaletteCommand,
} from "../../integration/palette-commands.js";
import { stashCommissioningReturnFocus, stashKeyboardShortcutsReturnFocus } from "../../integration/shortcuts.js";
import { chordKeyLabels, resolveShortcutChords, shortcutCommandLabel, useShortcutOverrides } from "../../integration/shortcut-bindings.js";
import { getViewModeSnapshot, useViewMode } from "../../integration/view-mode-store.js";
import { setMobileDestination, setMobileListTheater } from "../mobile/mobile-store.js";
import { presentRailPanel } from "../rail/rail-store.js";
import { openSettingsSurface } from "../../../../../features/settings/client/settings-door.js";
import { requestSideBarObjectiveAction, type SideBarObjectiveAction } from "../../../../../features/workspace/client/sidebar/interaction.js";
import {
  closeObjectiveSearch,
  focusObjective,
  openKeyboardShortcuts,
  openOnboarding,
  openWhatsNew,
  objectiveRecordSearchEntries,
  requestSideBarAddTheater,
  setActiveTheme,
  setObjectiveSearchMode,
} from "../../integration/store.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import type { ConsoleState, ObjectiveRecord } from "../../integration/types.js";
import type { MongleState } from "../../../../../features/workspace/shared/avatars.js";

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
  const railBindings = useDesktopRailEntries();
  const navigate = useNavigate();
  const location = useLocation();
  const [text, setText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  // 활성 행을 마지막으로 옮긴 입력 — 키보드일 때만 활성 행이 포커스 링을 그리고, 마우스가 옮긴 행은 hover 워시뿐이다.
  const [navigation, setNavigation] = useState<"keyboard" | "pointer">("keyboard");
  const [providerSearchGroups, setRailSearchGroups] = useState<readonly RailSearchGroup[]>([]);
  const capabilities = useHostCapabilities();
  const [shellNotice, setShellNotice] = useState<string | null>(null);
  useEffect(() => setShellNotice(null), [text, state.objectiveRecordSearchOpen]);
  const railSearchGroups = useMemo<readonly RailSearchGroup[]>(() => {
    const query = text.trim().toLowerCase();
    const matchesShell = query !== "" && ["shell", "셸", "쉘", "터미널", "terminal", "console"].some((alias) => alias.includes(query));
    if (!matchesShell || !desktopView) return providerSearchGroups;
    const theaterId = getViewedTheaterId();
    // 활성 Theater를 소유한 사령관 — Shell 기동이 Theater 루트를 찾는다. 모르면 생략한다.
    const commodoreId = getViewedCommodoreId();
    return [...providerSearchGroups, {
      panelId: "global-shell",
      panelTitle: "Shell",
      results: [
        { id: "open-shell", title: t("chrome.objectiveRecordSearch.openShell"), activate: () => undefined },
        ...(theaterId ? [{ id: "open-shell-here", title: t("chrome.objectiveRecordSearch.openShellHere"), activate: async () => {
          const result = await capabilities.shell.openAt({ theaterId, ...(commodoreId ? { commodoreId } : {}) }).catch(() => null);
          if (result?.ok) return;
          setShellNotice(t(result ? `chrome.objectiveRecordSearch.shell.${result.reason}` : "chrome.objectiveRecordSearch.shell.failed"));
          throw new Error("shell_open_refused");
        } }] : []),
      ],
    }];
  }, [providerSearchGroups, text, getViewedTheaterId(), getViewedCommodoreId(), desktopView, capabilities, t]);
  // 동작 띠가 펼쳐진 Objective 행과 그 안의 선택. 띠는 한 번에 하나만 선다.
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [actionIndex, setActionIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const appliedSeedNonceRef = useRef(0);
  const resultRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchGenerationRef = useRef(0);
  // 사이드바·커맨드 밴드와 같은 마크 축 — 안 본 채 끝난 Objective이 팔레트에서만 침묵하지 않게 한다.
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  // 보관된 Objective은 결과에서 뺀다. 보관함은 명령(open-archive)으로만 연다.
  const entries = useMemo(() => objectiveRecordSearchEntries(state), [state]);
  // 팔레트가 포인터 아래에 그려지거나 스크롤돼도, 포인터가 실제로 움직이기 전의 좌표는 선택을 옮기지 않는다.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  // 섹션 상태(실험 기능이 뒤늦게 알려지거나 scope가 바뀌는 일)를 팔레트가 열려 있는 동안 다시 읽는다.
  const [sectionVersion, setSectionVersion] = useState(0);
  const commodores = useCommodoreList();
  const viewedCommodoreId = useViewedCommodoreId();
  const zoneCommodoreId = useZoneCommodore();
  const commodore = commodores.find((row) => row.commodoreId === (viewedCommodoreId ?? zoneCommodoreId)) ?? null;
  // 이동 모드의 묶음은 사령관이다 — Theater 묶음·섹션 행은 세우지 않는다. 소유는
  // objectiveRecord.commodoreId로만 정한다(보관 항목의 theaterId는 사령관별 해시다).
  const commodoreRunPhase = useMemo(() => new Map(commodores.map((row) => [row.commodoreId, row.run.phase] as const)), [commodores]);
  // 구성원 이름·검색어는 보드 로스터의 역할이다 — 대화 명부 줄과 같은 출처(클러스터 구성원의 name).
  // 스토어 nested 타이틀(잘린 id) 대신 이것을 쓴다.
  const clusters = useObjectiveClusters();
  const memberNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const cluster of clusters) {
      for (const member of cluster.members) {
        if (!member.pending && member.name && !names.has(member.objectiveId)) names.set(member.objectiveId, member.name);
      }
    }
    return names;
  }, [clusters]);
  const commodoreGroups = useMemo<readonly CommodorePaletteGroup[]>(
    () => groupCommodorePaletteEntries({
        entries,
        members: state.nestedObjectiveRecords,
        memberNames,
        query: text,
        commodores: commodores.map((row) => ({
          commodoreId: row.commodoreId,
          ...(row.alias ? { alias: row.alias } : {}),
          label: row.label,
        })),
        viewedCommodoreId: viewedCommodoreId ?? zoneCommodoreId,
        recentRank: recentObjectiveRank,
        unknownLabel: t("chrome.objectiveRecordSearch.sectionFormer"),
      }),
    [entries, state.nestedObjectiveRecords, memberNames, text, commodores, viewedCommodoreId, zoneCommodoreId, t],
  );
  const ownedTheaters = useMemo(() => (commodore?.theaters ?? []).filter((row) => row.status === "available").map((row) => ({ id: row.theaterId, label: row.label })), [commodore]);
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
    () => state.objectiveRecordSearchOpen && desktopView ? buildTheaterSectionSearchEntries(ownedTheaters, theaterSections, language) : [],
    [state.objectiveRecordSearchOpen, ownedTheaters, theaterSections, language, desktopView, sectionVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // 이동 모드 주 목록의 렌더 순서 — 선택·키보드·스크롤이 모두 이 배열의 index를 쓴다.
  const primaryRows = useMemo<readonly PrimaryRow[]>(
    () => commodoreGroups.flatMap((group) => group.rows.map((row): PrimaryRow => {
      if (row.kind === "commodore") return { kind: "commodore", group, context: row.context, key: `commodore:${row.commodoreId}` };
      if (row.kind === "member") return { kind: "member", record: row.record, key: `member:${row.record.id}` };
      return { kind: "objective", entry: row.entry, context: row.context, key: objectiveRecordResultKey(row.entry.objectiveId) };
    })),
    [commodoreGroups],
  );
  const primaryIndexByKey = useMemo(() => new Map(primaryRows.map((row, index) => [row.key, index])), [primaryRows]);
  const undoAvailable = useMemo(() => canUndoLastClose?.() === true, [state.objectiveRecordSearchOpen, canUndoLastClose]);
  const undoKind = useMemo(() => lastUndoKind?.() ?? null, [state.objectiveRecordSearchOpen, lastUndoKind]);
  const commands = useMemo(
    () => buildPaletteCommands(state, railPanels, t, {
      canUndoLastClose: undoAvailable,
      commodore,
      undoKind,
      theaterSections: sectionEntries.map((section) => ({ theaterId: section.theaterId, sectionId: section.sectionId, pageId: section.pageId, titles: section.titles, icon: section.icon })),
    }),
    [state, railPanels, t, undoAvailable, undoKind, sectionEntries, commodore],
  );
  const recentCommandIds = useMemo(() => readRecentCommandIds(), [state.objectiveRecordSearchOpen]);
  const commandSections = useMemo<readonly { readonly id: "recent" | PaletteCommandGroup | "matches"; readonly commands: readonly ScoredPaletteCommand[] }[]>(() => {
    if (searchTokens(text).length === 0) {
      return groupPaletteCommands(commands, recentCommandIds).map((section) => ({
        id: section.id,
        commands: section.commands.map((command) => ({ command, score: 0, exactTokens: 0, matchedIndices: [] })),
      }));
    }
    return [{ id: "matches", commands: matchPaletteCommands(commands, text) }];
  }, [commands, recentCommandIds, text]);
  // 같은 명령이 최근 구역과 자기 구역에 함께 설 수 있다 — 선택·스크롤 키는 구역까지 담아 둘을 가른다.
  const commandRows = useMemo(
    () => commandSections.flatMap((section) => section.commands.map((scored) => ({ scored, key: commandResultKey(scored.command.commandId) + (section.id === "recent" ? ":recent" : "") }))),
    [commandSections],
  );
  const tokens = useMemo(() => searchTokens(text), [text]);
  const railSearchEntries = useMemo(
    // info 행(상한 표식 등)은 표시만 하고 키보드 이동·활성화 대상에서는 뺀다.
    () => railSearchGroups.flatMap((group) => group.results.filter((result) => result.kind !== "info").map((result) => ({ group, result }))).sort((a, b) => Number(b.result.exact === true) - Number(a.result.exact === true)),
    [railSearchGroups],
  );
  const exactCount = railSearchEntries.filter((entry) => entry.result.exact === true).length;
  // 한 목록의 순서 — 정확히 맞은 패널 결과, 목표·사령관·파일 결과, 명령 순이다. 각 묶음 안에서는
  // 지금의 점수 순서를 그대로 쓰고, 묶음 사이에는 섹션 제목을 두지 않는다.
  const primaryCount = primaryRows.length;
  const railRestCount = railSearchEntries.length - exactCount;
  const commandCount = commandRows.length;
  const resultCount = exactCount + primaryCount + railRestCount + commandCount;
  const clampedSelectedIndex = clampIndex(selectedIndex, resultCount);
  const selectedExactRail = clampedSelectedIndex < exactCount ? railSearchEntries[clampedSelectedIndex] ?? null : null;
  const primaryPos = clampedSelectedIndex - exactCount;
  const selectedPrimaryRow = selectedExactRail === null && primaryPos >= 0 && primaryPos < primaryCount ? primaryRows[primaryPos] ?? null : null;
  const restPos = primaryPos - primaryCount;
  const selectedRestRail = selectedExactRail === null && selectedPrimaryRow === null && restPos >= 0 && restPos < railRestCount ? railSearchEntries[exactCount + restPos] ?? null : null;
  const commandPos = restPos - railRestCount;
  const selectedCommand = selectedExactRail === null && selectedPrimaryRow === null && selectedRestRail === null && commandPos >= 0 && commandPos < commandCount ? commandRows[commandPos]?.scored ?? null : null;
  const selectedResultKey = (() => {
    if (selectedExactRail) return railResultKey(selectedExactRail.group.panelId, selectedExactRail.result.id);
    if (selectedPrimaryRow) return selectedPrimaryRow.key;
    if (selectedRestRail) return railResultKey(selectedRestRail.group.panelId, selectedRestRail.result.id);
    if (selectedCommand) return commandRows[commandPos]?.key;
    return undefined;
  })();
  const activeOptionId = selectedResultKey === undefined ? undefined : resultOptionId(selectedResultKey);
  // 동작 띠(→)는 지휘관 행에만 선다 — 사령관·구성원 행은 여는 일 하나뿐이다.
  const selectedObjective = selectedPrimaryRow?.kind === "objective" ? selectedPrimaryRow.entry : null;
  // 힌트의 조합 표기는 등록부의 현재 값이다 — 재배정이 바뀌면 함께 바뀐다.
  useShortcutOverrides();
  const undoShortcut = shortcutCommandLabel("console.undo-close");

  // 패널 내용 검색은 팔레트가 열려 있고 질의가 있을 때만 — 빈 입력에는 명령 홈만 보인다.
  useEffect(() => {
    const generation = ++searchGenerationRef.current;
    setRailSearchGroups([]);
    const theaterId = getViewedTheaterId();
    if (!state.objectiveRecordSearchOpen || text.trim() === "" || !theaterId) return;

    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void searchRailPanels(railPanels, text, theaterId, abort.signal, viewedCommodoreId).then((nextGroups) => {
        // provider가 abort를 무시해도 이전 세대 결과는 현재 팔레트에 반영하지 않는다.
        if (abort.signal.aborted || generation !== searchGenerationRef.current) return;
        setRailSearchGroups(nextGroups);
      });
    }, RAIL_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [text, railPanels, getViewedTheaterId(), state.objectiveRecordSearchOpen, t]);

  useEffect(() => {
    if (!state.objectiveRecordSearchOpen) {
      lastPointerRef.current = null;
      return;
    }
    lastPointerRef.current = null;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [state.objectiveRecordSearchOpen]);

  // seed는 번호가 바뀔 때마다 반영한다 — 초기 질의만 싣고, 모드는 이제 하나뿐이다.
  useEffect(() => {
    if (!state.objectiveRecordSearchOpen) {
      appliedSeedNonceRef.current = 0;
      setText("");
      setSelectedIndex(0);
      setActionsFor(null);
      return;
    }
    if (appliedSeedNonceRef.current === state.objectiveRecordSearchSeedNonce) return;
    appliedSeedNonceRef.current = state.objectiveRecordSearchSeedNonce;
    const seed = parsePaletteSeed(state.objectiveRecordSearchSeed);
    setText(seed.text);
    setSelectedIndex(0);
    setActionsFor(null);
    inputRef.current?.focus();
  }, [state.objectiveRecordSearchOpen, state.objectiveRecordSearchSeed, state.objectiveRecordSearchSeedNonce]);

  // 모드는 전역 단축키의 열림 표시로만 남는다 — ⌘K·⌘P가 같은 한 목록을 여닫는다.
  useEffect(() => {
    setObjectiveSearchMode(state.objectiveRecordSearchOpen ? "objectiveRecords" : null);
  }, [state.objectiveRecordSearchOpen]);

  // 첫 결과는 전체 목록의 맨 위 행이다. 여닫을 때도 고쳐 잡는다(닫힐 때 남은 선택이 다음 열림에 남지 않게).
  useEffect(() => {
    setSelectedIndex(0);
    setActionsFor(null);
  }, [state.objectiveRecordSearchOpen, text, resultCount]);

  useEffect(() => {
    if (!state.objectiveRecordSearchOpen || selectedResultKey === undefined) return;
    resultRefs.current.get(selectedResultKey)?.scrollIntoView({ block: "nearest" });
  }, [selectedResultKey, state.objectiveRecordSearchOpen]);

  if (!state.objectiveRecordSearchOpen) return null;

  const selectEntry = (objectiveId: string) => {
    // 선택은 대상 Objective으로 키보드 포커스를 넘기므로 닫힘 cleanup이 이전 UI 포커스를 되찾지 않게 한다.
    // 컴포저(또는 터미널) 포커스는 pendingObjectiveFocus → requestObjectiveKeyboardFocus 계약이 맡는다.
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
        setZoneCommodore(action.commodoreId);
        selectMobileCommodore(action.commodoreId);
        // Theater 전환은 대화 화면으로 포커스 문맥을 넘기므로 selectEntry처럼 이전 포커스 복원을 억제한다.
        previousFocusRef.current = null;
        closeConversationSurface();
        // 사이드바 Theater 머리처럼 누르는 순간 기여의 첫 칸을 읽고, 없으면 폰에서도 시스템 프롬프트로 간다.
        const landing = resolveTheaterInboxLanding(registry.theaterContributions, action.theaterId);
        openTheaterInbox({ theaterId: action.theaterId, ...(landing ?? { sectionId: "console:settings", pageId: "theaters" }) });
        navigate("/objectives");
        break;
      }
      case "switch-commodore": {
        setZoneCommodore(action.commodoreId);
        selectMobileCommodore(action.commodoreId);
        // 사령관 전환도 대화 화면으로 포커스 문맥을 넘기므로 이전 포커스 복원을 억제한다.
        previousFocusRef.current = null;
        // 폰에는 데스크톱 Inbox 호스트가 없다 — 폰 홈이 사령관 행을 여는 길(mobile-home)과 같이 목적지를 바꾼다.
        if (getViewModeSnapshot().effective === "mobile") {
          const home = commodores.find((row) => row.commodoreId === action.commodoreId)?.theaters.find((theater) => theater.status === "available")?.theaterId ?? null;
          if (home) setMobileListTheater({ commodoreId: action.commodoreId, theaterId: home });
          setMobileDestination({ kind: "plugin", entryId: "commodore", params: { commodoreId: action.commodoreId } });
          break;
        }
        closeConversationSurface();
        // 사령관 홈은 Theater가 아니라 사령관 UUID 주소의 Inbox다(사이드바 사령관 머리 표식과 같은 주소).
        openTheaterInbox({ theaterId: action.commodoreId, sectionId: "commodore:commodore", pageId: "log", returnFocus: null });
        if (!location.pathname.startsWith("/objectives")) navigate("/objectives");
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
        // 보는 사령관이 있으면 그 목록에 더하고, 없으면 새 사령관 만들기 흐름으로 이어진다.
        if (viewedCommodoreId) requestSideBarAddTheater(viewedCommodoreId);
        else requestCommodoreCreate();
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

  const selectCommodore = (commodoreId: string) => {
    runAction({ kind: "switch-commodore", commodoreId }, false);
  };

  const runCommand = (command: PaletteCommandEntry) => {
    noteCommandRun(command.commandId);
    runAction(command.action, command.current);
  };

  // Objective 행의 동작 띠. 정의는 명령 팔레트의 액션과 같다 — 같은 일이 두 자리에 서도 한 경로로 간다.
  const rowActions = (entry: ObjectiveSearchEntry): readonly RowAction[] => {
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
    if (selectedPrimaryRow) {
      const row = selectedPrimaryRow;
      if (row.kind === "commodore") {
        selectCommodore(row.group.commodoreId);
        return;
      }
      // 구성원은 부모가 대표하는 Objective — focusObjective이 부모 패널로 가서 그 구성원 본문을 보인다.
      if (row.kind === "member") {
        selectEntry(row.record.id);
        return;
      }
      const selected = row.entry;
      if (actionsFor === selected.objectiveId) rowActions(selected)[actionIndex]?.run();
      else selectEntry(selected.objectiveId);
      return;
    }
    if (selectedCommand) {
      runCommand(selectedCommand.command);
      return;
    }
    const panelEntry = selectedExactRail ?? selectedRestRail;
    if (panelEntry) void selectRailResult(panelEntry.group.panelId, panelEntry.result);
  };

  const handleInputChange = (value: string) => {
    // 접두 문법은 그대로 둔다 — 빈 입력에 `>`로 시작하는 값이 들어오면(타자든
    // `>sidebar` 붙여넣기든) 접두 뒤를 질의로 남기고 한 목록에서 찾는다.
    if (text === "" && isCommandModeInput(value)) {
      setText(commandModeQuery(value));
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

  // mouseenter는 행이 포인터 밑으로 그려져도 난다. 좌표가 바뀐 pointermove만 선택을 옮긴다.
  const onPalettePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const point = { x: event.clientX, y: event.clientY };
    const last = lastPointerRef.current;
    lastPointerRef.current = point;
    // 행이 포인터 밑으로 그려질 때 나는 이벤트는 movement가 0이고 좌표도 같다. 그건 선택이 아니다.
    const moved = event.movementX !== 0 || event.movementY !== 0 || (last !== null && (last.x !== point.x || last.y !== point.y));
    if (!moved) return;
    const hit = event.target instanceof Element ? event.target : null;
    if (!hit) return;
    const action = hit.closest<HTMLElement>("[data-palette-action]");
    if (action?.dataset.paletteAction !== undefined) {
      const next = Number(action.dataset.paletteAction);
      if (!Number.isInteger(next)) return;
      setNavigation("pointer");
      setActionIndex(next);
      return;
    }
    const option = hit.closest<HTMLElement>("[data-palette-index]");
    if (option?.dataset.paletteIndex === undefined) return;
    const next = Number(option.dataset.paletteIndex);
    if (!Number.isInteger(next)) return;
    setNavigation("pointer");
    setSelectedIndex(next);
  };

  const placeholder = t("chrome.objectiveRecordSearch.placeholder");
  const emptyMessage = t("chrome.objectiveRecordSearch.noMatching");

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
          const index = railIndex < exactCount ? railIndex : exactCount + primaryCount + (railIndex - exactCount);
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
              data-palette-index={index}
              onClick={() => { void selectRailResult(group.panelId, result); }}
            >
              <PaletteRailIcon icon={result.icon ?? panelIcon} />
              {/* 패널 결과는 두 줄이다 — 제목 아래에 부제(경로·태그)가 조용한 보조로 서고,
                  제목과 같은 부제(파일명 = 상대 경로)는 반복하지 않는다. */}
              <span className="objective-search-result-text">
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
        aria-label={t("chrome.objectiveRecordSearch.quickSearchDialog")}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onPointerMove={onPalettePointerMove}
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
        </div>
        <div id={LISTBOX_ID} className="objective-search-results" data-nav={navigation} role="listbox" aria-label={t("chrome.objectiveRecordSearch.objectiveRecordResults")}>
          {!hasResults ? (
            <p className="objective-search-empty">
              {emptyMessage}
            </p>
          ) : (
            <>
              {renderRailGroups(true)}
              {commodoreGroups.map((group, groupIndex) => (
                <div className="objective-search-commodore-group" key={group.commodoreId}>
                  {/* 묶음 사이 가는 선 — Theater 머리(h2)는 없다. 구분은 아바타와 들여쓰기만 말한다. */}
                  {groupIndex > 0 ? <div className="objective-search-group-sep" aria-hidden="true" /> : null}
                  {group.rows.map((row) => {
                    if (row.kind === "commodore") {
                      const resultKey = `commodore:${row.commodoreId}`;
                      const index = exactCount + (primaryIndexByKey.get(resultKey) ?? 0);
                      const active = index === clampedSelectedIndex;
                      // 사령관 상태는 목록이 들고 온 run.phase다(턴 중이면 작업 중, 그 밖 대기 중).
                      const working = (commodoreRunPhase.get(row.commodoreId) ?? null) === "turn";
                      return (
                        <button
                          id={resultOptionId(resultKey)}
                          key={resultKey}
                          ref={(node) => {
                            if (node) resultRefs.current.set(resultKey, node);
                            else resultRefs.current.delete(resultKey);
                          }}
                          type="button"
                          className={`objective-search-result objective-search-commodore-row${active ? " is-active" : ""}${row.context ? " is-context" : ""}`}
                          role="option"
                          aria-selected={active}
                          data-palette-index={index}
                          onClick={() => selectCommodore(row.commodoreId)}
                        >
                          <span className="objective-search-commodore-mark">
                            <CommodoreAvatar commodoreId={row.commodoreId} state={commodoreGroupMark(group, idleArrivalIds)} size={18} label={row.label} decorative />
                          </span>
                          <span className="objective-search-result-text">
                            <strong>{highlightText(row.label, tokens)}</strong>
                            <span className="objective-search-sr-only">{t("chrome.objectiveRecordSearch.roleCommodore")}</span>
                          </span>
                          {row.context ? null : (
                            <>
                              <span className={`objective-search-status${working ? " is-running" : ""}`}>
                                {working ? t("chrome.objectiveRecordSearch.commodoreWorking") : t("chrome.objectiveRecordSearch.commodoreWaiting")}
                              </span>
                              {/* 지휘관 행의 ▸와 같은 너비의 자리 — 상태 열의 오른쪽 끝을 맞춘다. */}
                              <ChevronGlyph direction="right" className="objective-search-row-arrow is-spacer" />
                            </>
                          )}
                        </button>
                      );
                    }
                    if (row.kind === "member") {
                      const record = row.record;
                      const resultKey = `member:${record.id}`;
                      const index = exactCount + (primaryIndexByKey.get(resultKey) ?? 0);
                      const active = index === clampedSelectedIndex;
                      // 구성원 상태도 사이드바 지휘관 행과 같은 말(CONVERSATION_ROW_PHRASE)이다.
                      const mark = resolveObjectiveMarkVisual({ activity: resolveObjectiveActivity(record, state.objectiveRecordRuntime), objectiveId: record.id, idleArrivalIds });
                      return (
                        <button
                          id={resultOptionId(resultKey)}
                          key={resultKey}
                          ref={(node) => {
                            if (node) resultRefs.current.set(resultKey, node);
                            else resultRefs.current.delete(resultKey);
                          }}
                          type="button"
                          className={`objective-search-result objective-search-member-row${active ? " is-active" : ""}`}
                          role="option"
                          aria-selected={active}
                          data-palette-index={index}
                          onClick={() => selectEntry(record.id)}
                        >
                          <span className="objective-search-op-mark">
                            <ObjectiveAvatar
                              objectiveRecord={{ id: record.id, parentObjectiveId: record.parentObjectiveId }}
                              state={mark}
                              size={16}
                              label={row.label}
                              decorative
                            />
                          </span>
                          <span className="objective-search-result-text">
                            <strong>{highlightText(row.label, tokens)}</strong>
                            <span className="objective-search-sr-only">{t("chrome.objectiveRecordSearch.roleMember")}</span>
                          </span>
                          <span className={`objective-search-status${mark === "running" ? " is-running" : mark === "awaiting" ? " is-awaiting" : ""}`}>{t(CONVERSATION_ROW_PHRASE[mark])}</span>
                          {/* 지휘관 행의 ▸와 같은 너비의 자리 — 상태 열의 오른쪽 끝을 맞춘다. */}
                          <ChevronGlyph direction="right" className="objective-search-row-arrow is-spacer" />
                        </button>
                      );
                    }
                    const entry = row.entry;
                    const index = exactCount + (primaryIndexByKey.get(objectiveRecordResultKey(entry.objectiveId)) ?? 0);
                    const active = index === clampedSelectedIndex;
                    const resultKey = objectiveRecordResultKey(entry.objectiveId);
                    const stripOpen = actionsFor === entry.objectiveId;
                    const actions = stripOpen ? rowActions(entry) : [];
                    // 오른쪽 상태는 한 단어다(칩 아님) — 사이드바 지휘관 행과 같은 출처·같은 말
                    // (CONVERSATION_ROW_PHRASE, idle은 "대기 중").
                    const mark = resolveObjectiveMarkVisual({ activity: entry.activity, objectiveId: entry.objectiveId, idleArrivalIds });
                    const status = t(CONVERSATION_ROW_PHRASE[mark]);
                    const statusTone = row.context ? "" : mark === "running" ? " is-running" : mark === "awaiting" ? " is-awaiting" : "";
                    return (
                      <div key={entry.objectiveId} className={`objective-search-row${stripOpen ? " has-actions" : ""}`}>
                        <button
                          id={resultOptionId(resultKey)}
                          ref={(node) => {
                            if (node) resultRefs.current.set(resultKey, node);
                            else resultRefs.current.delete(resultKey);
                          }}
                          type="button"
                          className={`objective-search-result objective-search-objective-row${active ? " is-active" : ""}${row.context ? " is-context" : ""}`}
                          role="option"
                          aria-selected={active}
                          data-palette-index={index}
                          onClick={() => selectEntry(entry.objectiveId)}
                        >
                          {/* 이름 왼쪽 슬롯은 사이드바 칩과 같은 활동 상태 소유다.
                              마크가 항상 서므로 제목 열이 어긋나지 않는다. */}
                          <span className="objective-search-op-mark">
                            <ObjectiveNameMark
                              objectiveRecord={{ id: entry.objectiveId, parentObjectiveId: entry.parentObjectiveId }}
                              status={mark}
                            />
                          </span>
                          <span className="objective-search-result-text">
                            <strong>{highlightText(entry.objectiveRecordName, tokens)}</strong>
                            <span className="objective-search-sr-only">{t("chrome.objectiveRecordSearch.roleCommander")}</span>
                          </span>
                          {row.context ? null : <span className={`objective-search-status${statusTone}`}>{status}</span>}
                          <ChevronGlyph direction={stripOpen ? "left" : "right"} className="objective-search-row-arrow" />
                        </button>
                        {stripOpen ? (
                          <div className="objective-search-actions" role="group" aria-label={t("chrome.objectiveRecordSearch.actionsAria", { title: entry.objectiveRecordName })}>
                            {actions.map((action, i) => (
                              <button
                                key={action.id}
                                type="button"
                                tabIndex={-1}
                                className={`objective-search-action${i === actionIndex ? " is-active" : ""}${action.danger ? " is-danger" : ""}`}
                                data-palette-action={i}
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
                </div>
              ))}
              {renderRailGroups(false)}
              {/* 명령은 결과 뒤에 한 목록으로 잇는다 — 섹션 제목 없이, 각 묶음 안의 점수 순서 그대로. */}
              {commandRows.map((row, position) => {
                const { command } = row.scored;
                const index = exactCount + primaryCount + railRestCount + position;
                const active = index === clampedSelectedIndex;
                return (
                  <button
                    id={resultOptionId(row.key)}
                    key={row.key}
                    ref={(node) => {
                      if (node) resultRefs.current.set(row.key, node);
                      else resultRefs.current.delete(row.key);
                    }}
                    type="button"
                    className={`objective-search-result${active ? " is-active" : ""}${command.danger ? " is-danger" : ""}`}
                    role="option"
                    aria-selected={active}
                    data-palette-index={index}
                    onClick={() => runCommand(command)}
                  >
                    <PaletteCommandGlyph command={command} />
                    <span className="objective-search-result-text">
                      <strong>{highlightIndices(command.label, row.scored.matchedIndices)}</strong>
                    </span>
                    {command.current ? <span className="objective-search-theater">{t("chrome.objectiveRecordSearch.current")}</span> : null}
                    {command.undoable ? <span className="objective-search-undoable">{t("chrome.objectiveRecordSearch.undoable", { shortcut: undoShortcut })}</span> : null}
                    {command.shortcut ? <span className="objective-search-shortcut">{chordKeyLabels(resolveShortcutChords(command.shortcut)[0] ?? "").map((key, keyIndex) => <kbd key={`${keyIndex}:${key}`}>{key}</kbd>)}</span> : null}
                  </button>
                );
              })}
            </>
          )}
        </div>
        {/* 단축키 안내 줄은 그리지 않는다 — 키보드 조작 문구는 보조기기에만 남긴다. */}
        <p className="objective-search-sr-only">{t("chrome.objectiveRecordSearch.legendMove")} ↑↓ · {t("chrome.objectiveRecordSearch.legendOpen")} Enter · {t("chrome.objectiveRecordSearch.legendActions")} → · {t("chrome.objectiveRecordSearch.legendClose")} Esc</p>
        {shellNotice ? <p className="archive-sheet-notice" role="alert">{shellNotice}</p> : null}
      </section>
    </div>
  );
}

type PrimaryRow =
  | { readonly kind: "commodore"; readonly group: CommodorePaletteGroup; readonly context: boolean; readonly key: string }
  | { readonly kind: "objective"; readonly entry: ObjectiveSearchEntry; readonly context: boolean; readonly key: string }
  | { readonly kind: "member"; readonly record: ObjectiveRecord; readonly key: string };

interface RowAction {
  readonly id: string;
  readonly label: string;
  readonly glyph: "objective-open" | "objective-resume" | "objective-rename" | "objective-archive";
  readonly danger?: boolean;
  readonly run: () => void;
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

function resultOptionId(resultKey: string): string {
  return `objective-search-option-${domIdPart(resultKey)}`;
}

function objectiveRecordResultKey(objectiveId: string): string {
  return `objectiveRecord:${objectiveId}`;
}

function commandResultKey(commandId: string): string {
  return `command:${commandId}`;
}

function railResultKey(panelId: string, resultId: string): string {
  return `panel:${panelId}:${resultId}`;
}

/** 사령관 행 아바타의 얼굴 — 묶음의 지휘관 중 가장 급한 활동 하나만 말한다(실행 중 > 대기, 그 밖 쉼). */
function commodoreGroupMark(group: CommodorePaletteGroup, idleArrivalIds: ReadonlySet<string>): MongleState {
  let awaiting = false;
  for (const row of group.rows) {
    if (row.kind !== "objective" || row.context) continue;
    const display = resolveObjectiveDisplayActivity({ activity: row.entry.activity, objectiveId: row.entry.objectiveId, idleArrivalIds });
    if (display === "running") return "running";
    if (display === "awaiting") awaiting = true;
  }
  return awaiting ? "awaiting" : "idle";
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
