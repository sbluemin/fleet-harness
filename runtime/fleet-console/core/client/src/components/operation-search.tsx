import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";
import type { PaneSearchResult, PaneTarget } from "@fleet-console/sdk/pane";
import { openExpandedSurface } from "../expanded-surface/store.js";
import { EXPANDED_PANE_SURFACE_ID } from "../pane/expanded-pane-surface.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { openPane } from "../pane/pane-store.js";
import type { RailPanelDescriptor, RailSearchResult } from "@fleet-console/sdk/rail";

import { launchProviderCaption, type LaunchProviderGlyphId } from "./launch-provider-glyphs.js";
import { OperationNameMark } from "./operation-name-mark.js";
import { setGlobalSettingsField } from "../global-settings-store.js";
import { toggleCommandBandDocked } from "../fullscreen-band-store.js";
import {
  filterOperationSearchEntries,
  groupOperationSearchEntries,
  RAIL_SEARCH_DEBOUNCE_MS,
  searchRailPanels,
  type PaletteSearchPanel,
  searchTokens,
  type RailSearchGroup,
} from "../operation-search.js";
import { resolveOperationMarkVisual } from "../operation-activity.js";
import { closeOperationCompletely, resumeOperationInPlace } from "../operation-actions.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../operation-marks.js";
import {
  buildPaletteCommands,
  commandModeQuery,
  isCommandModeInput,
  matchPaletteCommands,
  type PaletteCommandEntry,
} from "../palette-commands.js";
import { stashKeyboardShortcutsReturnFocus } from "../shortcuts.js";
import { forgetTheaterCompletely } from "../theater.js";
import type { DeferredDeletionReceipt } from "../api.js";
import { getLoadedTheaterId, clearFormationView, ensureDefaultGeometry, forceDropCompanionOperationId, getCompanionOperationId, getStationKeeping, loadForTheater, minimizeOperations, requestFitAllOperations, setStationKeeping, toggleFormationView } from "../canvas/canvas-store.js";
import { enterTriage, focusedTriageOperationId, forgetTriageOperation, isTriageActive, setTriageActive, visitTriageTheater } from "../canvas/triage-store.js";
import { getViewModeSnapshot } from "../view-mode-store.js";
import { openRailPanel, setRailChromeExpanded, toggleRailChrome } from "../rail/rail-store.js";
import { SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "../settings/settings-entry.js";
import { getSideBarState, setSideBarCollapsed, toggleSideBarStatusAxis } from "../sidebar/operations-side-bar-store.js";
import { requestSideBarOperationAction, type SideBarOperationAction } from "../sidebar/interaction.js";
import {
  closeOperationSearch,
  focusOperation,
  openKeyboardShortcuts,
  openWhatsNew,
  operationSearchEntries,
  requestOperationLaunchMenu,
  requestSideBarAddTheater,
  setActiveTheater,
  setActiveTheme,
} from "../store.js";
import { useT } from "../i18n/index.js";
import type { ConsoleState } from "../types.js";

interface OperationSearchProps {
  readonly state: ConsoleState;
  readonly railPanels: readonly PaletteSearchPanel[];
  // virtual:fleet-plugins 의존을 테스트 경계 밖으로 밀기 위해 registry 직접 import 대신 prop으로 받는다.
  readonly plugins: readonly FleetClientPlugin[];
  // 팔레트 close도 캔버스·사이드바와 같은 유예 큐에 receipt를 넣어야 Undo가 경로에 상관없이 동작한다.
  readonly onDeferredDeletion?: (deletion: DeferredDeletionReceipt | null) => void;
  readonly canUndoLastClose?: () => boolean;
  readonly onUndoLastClose?: () => void;
}

const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const LISTBOX_ID = "operation-search-listbox";
const UNASSIGNED_GROUP_KEY = "__unassigned__";
const COMMAND_GROUP_HEADING_ID = "operation-search-heading-commands";

export function OperationSearch({
  state,
  railPanels,
  plugins,
  onDeferredDeletion,
  canUndoLastClose,
  onUndoLastClose,
}: OperationSearchProps) {
  const t = useT();
  const railBindings = useRailEntries();
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [railSearchGroups, setRailSearchGroups] = useState<readonly RailSearchGroup[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const operationSearchWasOpenRef = useRef(false);
  const resultRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchGenerationRef = useRef(0);
  const commandMode = isCommandModeInput(query);
  // 사이드바·커맨드 밴드와 같은 마크 축 — 안 본 채 끝난 Operation이 팔레트에서만 침묵하지 않게 한다.
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const entries = useMemo(() => operationSearchEntries(state), [state]);
  const filteredEntries = useMemo(() => filterOperationSearchEntries(entries, query), [entries, query]);
  const groups = useMemo(() => groupOperationSearchEntries(filteredEntries), [filteredEntries]);
  const undoAvailable = useMemo(() => canUndoLastClose?.() === true, [state.operationSearchOpen, canUndoLastClose]);
  const activeTheaterHasWiki = state.theaters.find((candidate) => candidate.id === state.activeTheaterId)?.hasWiki === true;
  const commands = useMemo(
    () => buildPaletteCommands(state, railPanels, t, { canUndoLastClose: undoAvailable }),
    [state, railPanels, t, undoAvailable],
  );
  const matchedCommands = useMemo(
    () => (commandMode ? matchPaletteCommands(commands, commandModeQuery(query)) : []),
    [commandMode, commands, query],
  );
  const tokens = useMemo(() => searchTokens(commandMode ? commandModeQuery(query) : query), [commandMode, query]);
  const railSearchEntries = useMemo(
    // info 행(상한 표식 등)은 표시만 하고 키보드 이동·활성화 대상에서는 뺀다.
    () => railSearchGroups.flatMap((group) => group.results.filter((result) => result.kind !== "info").map((result) => ({ group, result }))),
    [railSearchGroups],
  );
  const primaryResultCount = commandMode
    ? matchedCommands.length + railSearchEntries.length
    : filteredEntries.length + railSearchEntries.length;
  const resultCount = primaryResultCount;
  const clampedSelectedIndex = clampIndex(selectedIndex, resultCount);
  const selectedResultKey = commandMode
    ? matchedCommands[clampedSelectedIndex]
      ? commandResultKey(matchedCommands[clampedSelectedIndex]!.command.commandId)
      : railSearchEntries[clampedSelectedIndex - matchedCommands.length]
        ? railResultKey(
          railSearchEntries[clampedSelectedIndex - matchedCommands.length]!.group.panelId,
          railSearchEntries[clampedSelectedIndex - matchedCommands.length]!.result.id,
        )
        : undefined
    : filteredEntries[clampedSelectedIndex]
      ? operationResultKey(filteredEntries[clampedSelectedIndex]!.operationId)
      : railSearchEntries[clampedSelectedIndex - filteredEntries.length]
        ? railResultKey(
          railSearchEntries[clampedSelectedIndex - filteredEntries.length]!.group.panelId,
          railSearchEntries[clampedSelectedIndex - filteredEntries.length]!.result.id,
        )
        : undefined;
  const activeOptionId = selectedResultKey === undefined
    ? undefined
    : resultOptionId(selectedResultKey);


  useEffect(() => {
    const generation = ++searchGenerationRef.current;
    setRailSearchGroups([]);
    const theaterId = state.activeTheaterId;
    const effectiveQuery = commandMode ? commandModeQuery(query) : query;
    if (!state.operationSearchOpen || effectiveQuery.trim() === "" || !theaterId) return;

    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void searchRailPanels(railPanels, effectiveQuery, theaterId, abort.signal).then((nextGroups) => {
        // provider가 abort를 무시해도 이전 세대 결과는 현재 팔레트에 반영하지 않는다.
        if (abort.signal.aborted || generation !== searchGenerationRef.current) return;
        setRailSearchGroups(nextGroups);
      });
    }, RAIL_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [commandMode, query, railPanels, state.activeTheaterId, state.operationSearchOpen, t]);

  useEffect(() => {
    if (!state.operationSearchOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [state.operationSearchOpen]);

  useEffect(() => {
    const opening = state.operationSearchOpen && !operationSearchWasOpenRef.current;
    operationSearchWasOpenRef.current = state.operationSearchOpen;
    if (opening) setQuery(state.operationSearchSeed ?? "");
  }, [state.operationSearchOpen, state.operationSearchSeed]);

  useEffect(() => {
    if (!state.operationSearchOpen) {
      setQuery("");
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex(0);
  }, [state.operationSearchOpen, query]);

  useEffect(() => {
    if (!state.operationSearchOpen || selectedResultKey === undefined) return;
    resultRefs.current.get(selectedResultKey)?.scrollIntoView({ block: "nearest" });
  }, [selectedResultKey, state.operationSearchOpen]);

  if (!state.operationSearchOpen) return null;

  const selectEntry = (operationId: string) => {
    // 선택은 대상 Operation으로 키보드 포커스를 넘기므로 닫힘 cleanup이 이전 UI 포커스를 되찾지 않게 한다.
    previousFocusRef.current = null;
    // 최대화 해제는 이동 경로(operations.tsx의 pendingOperationFocus 소비)에 위임한다 — 최대화 중이면 유지·교체.
    focusOperation(operationId);
    navigate("/operations");
    closeOperationSearch();
  };

  const selectRailResult = async (panelId: string, result: PaneSearchResult) => {
    // activate가 plugin-local 논리 타깃을 먼저 기록한 뒤에만 host route/rail을 연다.
    previousFocusRef.current = null;
    let target: PaneTarget | void;
    try {
      target = await result.activate();
    } catch {
      return;
    }
    // 경로만 옮기고 주소는 그대로 둔다. `navigate("/operations")`는 쿼리를 함께 버리는데,
    // activate가 방금 기록한 것이 바로 그 쿼리다 — 주소로 문서를 여는 플러그인은 자기가
    // 세운 주소가 이 한 줄에 지워져 아무 일도 일어나지 않는다(실측: 팔레트로 연 Codex 항목).
    navigate({ pathname: "/operations", search: window.location.search });
    // 계약을 따르는 공급자는 열 자리를 값으로 돌려준다. 그 경우 부작용에 기대지 않고 여기서
    // 직접 착지시킨다 — 싱글턴을 쓰지 않는 외부 공급자는 이 경로가 없으면 결과를 열지 못한다.
    // 폰에는 레일이 없다 — 설정 타깃은 모바일 표현(/settings 페이지)의 같은 섹션으로 보낸다.
    if (target && getViewModeSnapshot().effective === "mobile" && target.paneId === SETTINGS_PANE_ID) {
      const section = target.params?.section;
      navigate({ pathname: "/settings", search: section === undefined ? "" : `?section=${encodeURIComponent(section)}` });
      closeOperationSearch();
      return;
    }
    if (target) {
      const owner = railBindings.find((binding) => binding.panes.some((pane) => pane.id === target!.paneId));
      const descriptor = owner?.panes.find((pane) => pane.id === target!.paneId);
      const mount = target.mount ?? descriptor?.mounts[0] ?? "rail";
      if (mount === "expanded") {
        openExpandedSurface({ surfaceId: EXPANDED_PANE_SURFACE_ID, params: { ...target.params, paneId: target.paneId } });
      } else {
        openRailPanel(owner?.entry.id ?? panelId);
        openPane({ paneId: target.paneId, ...(target.params ? { params: target.params } : {}) });
      }
    } else {
      openRailPanel(panelId);
    }
    setRailChromeExpanded(true);
    closeOperationSearch();
  };

  const runCommand = (command: PaletteCommandEntry) => {
    const action = command.action;
    switch (action.kind) {
      case "undo-close": {
        previousFocusRef.current = null;
        if (canUndoLastClose?.()) onUndoLastClose?.();
        break;
      }
      case "switch-theater": {
        if (command.current) break;
        // Theater 전환은 캔버스로 포커스 문맥을 넘기므로 selectEntry처럼 이전 포커스 복원을 억제한다.
        previousFocusRef.current = null;
        // 선별 중 수동 전환도 방문 경로를 타야 목적지의 저장된 Formation/companion이 부활하지 않는다.
        if (isTriageActive()) visitTriageTheater(action.theaterId);
        else setActiveTheater(action.theaterId);
        navigate("/operations");
        break;
      }
      case "new-theater": {
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        // 생성 요청의 소비자(Map 사이드바)는 선별 중 언마운트다 — 먼저 선별을 끝내야
        // 요청이 폐기되지 않고 즉시 소비된다(종료의 대기 요청 폐기보다 뒤에 요청).
        if (isTriageActive()) setTriageActive(false);
        if (getSideBarState().collapsed) setSideBarCollapsed(false);
        requestSideBarAddTheater();
        break;
      }
      case "new-operation": {
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        if (isTriageActive()) setTriageActive(false);
        requestOperationLaunchMenu();
        break;
      }
      case "resume-operation": {
        // plugin이 resumeOperation 훅을 제공하면 직접 재개하고, 미제공 시에만 프레임 포커스로 폭백한다.
        // 실패 시에는 포커스하지 않는다 — focusOperation은 알림을 제거하므로(store.ts) plugin이 emit한
        // agent.resume-failed가 지워져 침묵 실패가 된다. 실패 피드백은 칩 뱃지 + Alerts 항목이 담당한다.
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        resumeOperationInPlace(action.operationId, state.operations, plugins, focusOperation);
        break;
      }
      case "close-operation": {
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        // Analyze/companion 대상을 닫을 때는 캔버스/사이드바 close 경로(operations.tsx handleClose)와
        // 같이 companion을 먼저 해제한다 — 두면 삭제된 op가 fallback dormant 프레임으로 잔존한다(Codex P2).
        if (getCompanionOperationId() === action.operationId) forceDropCompanionOperationId();
        const operation = state.operations.find((op) => op.id === action.operationId);
        const plugin = (operation ? plugins.find((candidate) => candidate.id === operation.pluginId) : null) ?? null;
        void closeOperationCompletely(action.operationId, plugin).then((deletion) => {
          forgetTriageOperation(action.operationId);
          onDeferredDeletion?.(deletion);
        });
        break;
      }
      case "minimize-all-operations": {
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        // Operations 미마운트 경로(/settings 등)에서는 canvas store가 아직 Theater를 로드하지 않아
        // 액션이 no-op이 된다(Codex P2). 동일 Theater 재로드는 flush 후 저장값 재독이라 안전하다.
        ensurePaletteCanvasTheater(state);
        // minimizeOperations는 geometry 맵에 없는 id를 버리므로, 페이지와 같이 현재 op의 기본
        // geometry를 먼저 심는다 — persisted canvas가 없는 신규 op도 최소화 대상이 된다.
        const theaterOperations = state.operations.filter((op) => op.theaterId === state.activeTheaterId);
        for (const operation of theaterOperations) ensureDefaultGeometry(operation.id, operation.geometry);
        minimizeOperations(theaterOperations.map((op) => op.id));
        break;
      }
      case "fit-all-panels": {
        // mobile은 MobileShell이 OperationsCanvas를 대신 렌더해 크기 등록소가 비어 있으므로,
        // 요청을 남기면 이후 desktop 전환 때 stale fit이 튀어나온다 — ⇧1의 mobile 게이트와 같은 정책으로 차단.
        if (getViewModeSnapshot().effective === "mobile") break;
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        ensurePaletteCanvasTheater(state);
        if (!isTriageActive()) requestFitAllOperations();
        break;
      }
      case "toggle-triage-mode": {
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        ensurePaletteCanvasTheater(state);
        if (isTriageActive()) {
          setTriageActive(false);
        } else if (state.theaters.length > 0) {
          // 팔레트 진입 시점의 activeElement는 입력창이므로 캔버스 포커스는 previousFocusRef에서 읽는다.
          // 그 뒤 복원을 끊지 않으면 팔레트가 닫히며 이전 패널을 다시 포커스해 빈 대기열 진입의 해제가 무효화된다.
          const focusedOperationId = focusedTriageOperationId(previousFocusRef.current);
          previousFocusRef.current = null;
          enterTriage(focusedOperationId);
        }
        break;
      }
      case "toggle-formation": {
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        ensurePaletteCanvasTheater(state);
        toggleFormationView();
        break;
      }
      case "toggle-station-keeping": {
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        ensurePaletteCanvasTheater(state);
        // 팔레트는 규율이 사는 곳으로 데려간다 — Tactical/War Room이면 Cruise로 나온 뒤 전환해,
        // 광고된 커맨드가 무음 no-op이 되지 않고 전환 결과(펼침 포함)가 즉시 보이게 한다.
        if (isTriageActive()) setTriageActive(false);
        clearFormationView();
        setStationKeeping(!getStationKeeping());
        break;
      }
      case "toggle-status-axis": {
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        toggleSideBarStatusAxis();
        break;
      }
      case "open-rail-panel": {
        // rail·사이드바는 operations 페이지에만 마운트되므로 다른 경로에서는 먼저 이동한다.
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        openRailPanel(action.panelId);
        setRailChromeExpanded(true);
        break;
      }
      case "toggle-rail": {
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        // 닫힘 cleanup의 포커스 복원 타깃을 command-band의 rail 토글로 재지정한다(미발견 시 복원 억제).
        previousFocusRef.current = document.querySelector<HTMLElement>(".command-band-rail-toggle");
        toggleRailChrome();
        break;
      }
      case "toggle-sidebar": {
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        previousFocusRef.current = document.querySelector<HTMLElement>(".command-band-sidebar-toggle");
        setSideBarCollapsed(!getSideBarState().collapsed);
        break;
      }
      case "toggle-command-band-dock": {
        toggleCommandBandDocked();
        break;
      }
      case "switch-theme": {
        if (command.current) break;
        const previousTheme = state.activeTheme;
        setActiveTheme(action.theme);
        void setGlobalSettingsField("theme", action.theme).then((saved) => {
          if (!saved) setActiveTheme(previousTheme);
        });
        break;
      }
      case "open-settings": {
        // 폰에는 레일이 없다 — 설정의 모바일 표현은 여전히 /settings 페이지다. 레일 스토어를
        // 열면 보이지 않는 표면만 켜지고 화면은 아무 일도 없던 것처럼 남는다.
        if (getViewModeSnapshot().effective === "mobile") {
          previousFocusRef.current = null;
          navigate("/settings");
          break;
        }
        // 설정은 라우트가 아니라 레일 표면이다 — 포커스는 표면이 받으므로 복원을 억제한다.
        previousFocusRef.current = null;
        // 레일은 /operations에만 마운트된다. 주소 쿼리는 selectRailResult와 같은 이유로 지킨다.
        if (!location.pathname.startsWith("/operations")) navigate({ pathname: "/operations", search: window.location.search });
        openRailPanel(SETTINGS_RAIL_ENTRY_ID);
        setRailChromeExpanded(true);
        // 복원을 억제했으면 도착지가 받아야 한다 — 페인은 이 커밋의 재렌더 뒤에야 서므로
        // 프레임을 하나 넘겨 검색 입력(첫 컨트롤)으로 보낸다. 실패 시 표면 본문이 받는다.
        window.requestAnimationFrame(() => {
          const landing = document.querySelector<HTMLElement>(".settings-pane .settings-search input")
            ?? document.querySelector<HTMLElement>(`#rail-panel-${SETTINGS_RAIL_ENTRY_ID}`);
          landing?.focus();
        });
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
      case "rename-operation":
      case "assign-operation-group":
      case "set-operation-accent":
      case "minimize-operation": {
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        if (getSideBarState().collapsed) setSideBarCollapsed(false);
        requestSideBarOperationAction(action.operationId, paletteActionToSideBarAction(action.kind));
        break;
      }
      case "whats-new": {
        openWhatsNew();
        break;
      }
      case "forget-theater": {
        void forgetTheaterCompletely(action.theaterId).then(onDeferredDeletion);
        break;
      }
    }
    closeOperationSearch();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeOperationSearch();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => clampIndex(current + (event.key === "ArrowDown" ? 1 : -1), resultCount));
      return;
    }
    if (event.key === "Enter") {
      if (commandMode) {
        const selected = matchedCommands[clampedSelectedIndex];
        if (selected) {
          event.preventDefault();
          runCommand(selected.command);
          return;
        }
        const panelEntry = railSearchEntries[clampedSelectedIndex - matchedCommands.length];
        if (panelEntry) {
          event.preventDefault();
          void selectRailResult(panelEntry.group.panelId, panelEntry.result);
          return;
        }
        return;
      }
      const selected = filteredEntries[clampedSelectedIndex];
      if (selected) {
        event.preventDefault();
        selectEntry(selected.operationId);
        return;
      }
      const panelEntry = railSearchEntries[clampedSelectedIndex - filteredEntries.length];
      if (panelEntry) {
        event.preventDefault();
        void selectRailResult(panelEntry.group.panelId, panelEntry.result);
        return;
      }
      return;
    }
    if (event.key === "Tab") trapFocus(event, cardRef.current);
  };


  return (
    <div className="operation-search-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeOperationSearch();
    }}>
      <section
        ref={cardRef}
        className="operation-search-card"
        role="dialog"
        aria-modal="true"
        aria-label={commandMode ? t("chrome.operationSearch.commandsDialog") : t("chrome.operationSearch.quickSearchDialog")}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="operation-search-field">
          <SearchIcon />
          <input
            ref={inputRef}
            id="operation-search-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("chrome.operationSearch.placeholder")}
            autoComplete="off"
            role="combobox"
            aria-expanded={true}
            aria-controls={LISTBOX_ID}
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            spellCheck={false}
          />
          <kbd>esc</kbd>
        </div>
        <div id={LISTBOX_ID} className="operation-search-results" role="listbox" aria-label={commandMode ? t("chrome.operationSearch.commandResults") : t("chrome.operationSearch.operationResults")}>
          {commandMode ? (
            matchedCommands.length > 0 || railSearchGroups.length > 0 ? <>
              {matchedCommands.length > 0 ? (
                <section className="operation-search-section" role="group" aria-labelledby={COMMAND_GROUP_HEADING_ID}>
                  <h2 id={COMMAND_GROUP_HEADING_ID} className="operation-search-section-heading">{t("chrome.operationSearch.commands")}</h2>
                  {matchedCommands.map((scored, index) => {
                    const { command } = scored;
                    const active = index === clampedSelectedIndex;
                    const resultKey = commandResultKey(command.commandId);
                    return (
                      <button
                        id={commandOptionId(command.commandId)}
                        key={command.commandId}
                        ref={(node) => {
                          if (node) resultRefs.current.set(resultKey, node);
                          else resultRefs.current.delete(resultKey);
                        }}
                        type="button"
                        className={`operation-search-result ${active ? "is-active" : ""}`}
                        role="option"
                        aria-selected={active}
                        onMouseEnter={() => setSelectedIndex(index)}
                        onClick={() => runCommand(command)}
                      >
                        <span className="operation-search-command-glyph" aria-hidden="true">›</span>
                        <span className="operation-search-result-text">
                          <strong>{highlightIndices(command.label, scored.matchedIndices)}</strong>
                        </span>
                        {command.current ? <span className="operation-search-theater">{t("chrome.operationSearch.current")}</span> : null}
                      </button>
                    );
                  })}
                </section>
              ) : null}
              {railSearchGroups.map((group) => {
                const headingId = railGroupHeadingId(group.panelId);
                return (
                  <section className="operation-search-section operation-search-panel-section" key={group.panelId} role="group" aria-labelledby={headingId}>
                    <h2 id={headingId} className="operation-search-section-heading">{group.panelTitle}</h2>
                    {group.results.map((result) => {
                      const index = matchedCommands.length + railSearchEntries.findIndex((entry) => entry.group.panelId === group.panelId && entry.result === result);
                      const active = index === clampedSelectedIndex;
                      const resultKey = railResultKey(group.panelId, result.id);
                      if (result.kind === "info") {
                        // 읽기 전용 표식 행 — option 역할·활성화·"열기" 어포던스를 모두 붙이지 않는다.
                        return (
                          <div
                            key={result.id}
                            className="operation-search-result operation-search-panel-info"
                          >
                            <span className="operation-search-result-text">
                              <strong>{highlightText(result.title, tokens)}</strong>
                              {result.subtitle ? <small>{highlightText(result.subtitle, tokens)}</small> : null}
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
                          className={`operation-search-result operation-search-panel-result ${active ? "is-active" : ""}`}
                          role="option"
                          aria-selected={active}
                          onMouseEnter={() => setSelectedIndex(index)}
                          onClick={() => { void selectRailResult(group.panelId, result); }}
                        >
                          <span className="operation-search-result-text">
                            <strong>{highlightText(result.title, tokens)}</strong>
                            {result.subtitle ? <small>{highlightText(result.subtitle, tokens)}</small> : null}
                          </span>
                          <span className="operation-search-panel-open">{t("chrome.operationSearch.open")}</span>
                        </button>
                      );
                    })}
                  </section>
                );
              })}
            </> : <p className="operation-search-empty">{t("chrome.operationSearch.noMatchingCommands")}</p>
          ) : (
            groups.length > 0 || railSearchGroups.length > 0 ? <>
              {groups.map((group) => {
                const headingId = operationGroupHeadingId(group.theaterId);
                return (
                  <section className="operation-search-section" key={group.theaterId ?? UNASSIGNED_GROUP_KEY} role="group" aria-labelledby={headingId}>
                    <h2 id={headingId} className="operation-search-section-heading">{highlightText(group.theaterLabel, tokens)}</h2>
                    {group.entries.map((entry) => {
                      const index = filteredEntries.indexOf(entry);
                      const active = index === clampedSelectedIndex;
                      const resultKey = operationResultKey(entry.operationId);
                      return (
                        <button
                          id={resultOptionId(resultKey)}
                          key={entry.operationId}
                          ref={(node) => {
                            if (node) resultRefs.current.set(resultKey, node);
                            else resultRefs.current.delete(resultKey);
                          }}
                          type="button"
                          className={`operation-search-result ${active ? "is-active" : ""}`}
                          role="option"
                          aria-selected={active}
                          onMouseEnter={() => setSelectedIndex(index)}
                          onClick={() => selectEntry(entry.operationId)}
                        >
                          {/* 이름 왼쪽 슬롯은 사이드바 칩과 같은 활동 상태 소유다(Shell만 종류 글리프).
                              마크가 항상 서므로 무공급자 행도 제목 열이 어긋나지 않고, 공급자는
                              메타 캡션 텍스트로 강등 보존된다. */}
                          <span className="operation-search-op-mark">
                            <OperationNameMark
                              operation={entry}
                              status={resolveOperationMarkVisual({ activity: entry.activity, operationId: entry.operationId, idleArrivalIds })}
                            />
                          </span>
                          <span className="operation-search-result-text">
                            <strong>{highlightText(entry.operationName, tokens)}</strong>
                            <small>{operationMeta(entry)}</small>
                          </span>
                          <span className="operation-search-theater">{highlightText(entry.theaterLabel, tokens)}</span>
                        </button>
                      );
                    })}
                  </section>
                );
              })}
              {railSearchGroups.map((group) => {
                const headingId = railGroupHeadingId(group.panelId);
                return (
                  <section className="operation-search-section operation-search-panel-section" key={group.panelId} role="group" aria-labelledby={headingId}>
                    <h2 id={headingId} className="operation-search-section-heading">{group.panelTitle}</h2>
                    {group.results.map((result) => {
                      const index = filteredEntries.length + railSearchEntries.findIndex((entry) => entry.group.panelId === group.panelId && entry.result === result);
                      const active = index === clampedSelectedIndex;
                      const resultKey = railResultKey(group.panelId, result.id);
                      if (result.kind === "info") {
                        // 읽기 전용 표식 행 — option 역할·활성화·"열기" 어포던스를 모두 붙이지 않는다.
                        return (
                          <div
                            key={result.id}
                            className="operation-search-result operation-search-panel-info"
                          >
                            <span className="operation-search-result-text">
                              <strong>{highlightText(result.title, tokens)}</strong>
                              {result.subtitle ? <small>{highlightText(result.subtitle, tokens)}</small> : null}
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
                          className={`operation-search-result operation-search-panel-result ${active ? "is-active" : ""}`}
                          role="option"
                          aria-selected={active}
                          onMouseEnter={() => setSelectedIndex(index)}
                          onClick={() => { void selectRailResult(group.panelId, result); }}
                        >
                          <span className="operation-search-result-text">
                            <strong>{highlightText(result.title, tokens)}</strong>
                            {result.subtitle ? <small>{highlightText(result.subtitle, tokens)}</small> : null}
                          </span>
                          <span className="operation-search-panel-open">{t("chrome.operationSearch.open")}</span>
                        </button>
                      );
                    })}
                  </section>
                );
              })}
            </> : <p className="operation-search-empty">{t("chrome.operationSearch.noMatching")}</p>
          )}
        </div>
      </section>
    </div>
  );
}

function paletteActionToSideBarAction(
  kind: "rename-operation" | "assign-operation-group" | "set-operation-accent" | "minimize-operation",
): SideBarOperationAction {
  switch (kind) {
    case "rename-operation": return "rename";
    case "assign-operation-group": return "assign-group";
    case "set-operation-accent": return "set-accent";
    case "minimize-operation": return "minimize";
  }
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

// Operations 페이지 미마운트 상태에서 canvas 의존 커맨드가 no-op이 되지 않도록
// 활성 Theater를 canvas store에 선로드한다(같은 Theater 재로드는 저장값 재독으로 무해).
function ensurePaletteCanvasTheater(state: ConsoleState): void {
  if (state.activeTheaterId && getLoadedTheaterId() !== state.activeTheaterId) {
    loadForTheater(state.activeTheaterId);
  }
}

// 메타의 둘째 단어는 실행 공급자다 — 예전의 상수 "operation"은 전 행이 반복하는 죽은 단어였고,
// 공급자 글리프가 마크 슬롯을 떠나면서 정체성은 이 조용한 텍스트가 이어받는다.
function operationMeta(entry: { readonly pluginId: string; readonly launchProvider: LaunchProviderGlyphId | null }): string {
  return [entry.pluginId, entry.launchProvider ? launchProviderCaption(entry.launchProvider) : null].filter(Boolean).join(" · ");
}

function operationGroupHeadingId(theaterId: string | null): string {
  return `operation-search-heading-${domIdPart(theaterId ?? UNASSIGNED_GROUP_KEY)}`;
}

function commandOptionId(commandId: string): string {
  return resultOptionId(commandResultKey(commandId));
}

function resultOptionId(resultKey: string): string {
  return `operation-search-option-${domIdPart(resultKey)}`;
}

function operationResultKey(operationId: string): string {
  return `operation:${operationId}`;
}

function commandResultKey(commandId: string): string {
  return `command:${commandId}`;
}

function railResultKey(panelId: string, resultId: string): string {
  return `panel:${panelId}:${resultId}`;
}

function railGroupHeadingId(panelId: string): string {
  return `operation-search-heading-panel-${domIdPart(panelId)}`;
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
