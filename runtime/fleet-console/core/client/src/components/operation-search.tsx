import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { ClientExecutionProvider } from "@fleet-console/sdk/plugin";
import type { PaneSearchResult, PaneTarget } from "@fleet-console/sdk/pane";
import { openExpandedSurface } from "../expanded-surface/store.js";
import { EXPANDED_PANE_SURFACE_ID } from "../pane/expanded-pane-surface.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { openPane } from "../pane/pane-store.js";
import type { RailPanelDescriptor, RailSearchResult } from "@fleet-console/sdk/rail";

import { OperationNameMark } from "./operation-name-mark.js";
import { setGlobalSettingsField } from "../global-settings-store.js";
import { toggleCommandBandDocked } from "../fullscreen-band-store.js";
import {
  filterOperationSearchEntries,
  groupOperationSearchEntries,
  orderOperationSearchEntries,
  PALETTE_MODES,
  paletteModeForPrefix,
  parsePaletteSeed,
  RAIL_SEARCH_DEBOUNCE_MS,
  searchRailPanels,
  searchTokens,
  type OperationSearchEntry,
  type PaletteMode,
  type PaletteSearchPanel,
  type RailSearchGroup,
} from "../operation-search.js";
import { noteCommandRun, readRecentCommandIds } from "../palette-recent.js";
import { PaletteActionGlyph, PaletteCommandGlyph, PaletteRailIcon, PaletteSectionGlyph } from "./palette-glyphs.js";
import { resolveOperationMarkVisual } from "../operation-activity.js";
import { closeOperationCompletely, resumeOperationInPlace } from "../operation-actions.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../operation-marks.js";
import {
  buildPaletteCommands,
  groupPaletteCommands,
  matchPaletteCommands,
  type PaletteCommandAction,
  type PaletteCommandEntry,
  type PaletteCommandGroup,
  type ScoredPaletteCommand,
} from "../palette-commands.js";
import { stashCommissioningReturnFocus, stashKeyboardShortcutsReturnFocus } from "../shortcuts.js";
import { chordKeyLabels, resolveShortcutChords, shortcutCommandLabel, useShortcutOverrides } from "../shortcut-bindings.js";
import type { DeferredDeletionReceipt } from "../api.js";
import { getLoadedTheaterId, clearFormationView, ensureDefaultGeometry, forceDropCompanionOperationId, getCompanionOperationId, getStationKeeping, loadForTheater, minimizeOperations, requestFitAllOperations, setStationKeeping, toggleFormationView } from "../canvas/canvas-store.js";
import { enterTriage, focusedTriageOperationId, forgetTriageOperation, isTriageActive, setTriageActive, visitTriageTheater } from "../canvas/triage-store.js";
import { getViewModeSnapshot } from "../view-mode-store.js";
import { getRailStoreSnapshot, openRailPanel, setRailChromeExpanded, toggleRailChrome } from "../rail/rail-store.js";
import { SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "../settings/settings-entry.js";
import { getSideBarState, setSideBarCollapsed, toggleSideBarStatusAxis } from "../sidebar/operations-side-bar-store.js";
import { requestSideBarOperationAction, type SideBarOperationAction } from "../sidebar/interaction.js";
import {
  closeOperationSearch,
  focusOperation,
  openKeyboardShortcuts,
  openOnboarding,
  openWhatsNew,
  operationSearchEntries,
  requestOperationLaunchMenu,
  requestSideBarAddTheater,
  setActiveTheater,
  setActiveTheme,
  setOperationSearchMode,
} from "../store.js";
import { useT } from "../i18n/index.js";
import type { ConsoleState } from "../types.js";
import { setZenMode, toggleZenMode, useZenMode } from "../zen-mode.js";

interface OperationSearchProps {
  readonly state: ConsoleState;
  readonly railPanels: readonly PaletteSearchPanel[];
  // virtual:fleet-plugins 의존을 테스트 경계 밖으로 밀기 위해 registry 직접 import 대신 prop으로 받는다.
  readonly plugins: readonly ClientExecutionProvider[];
  // 팔레트 close도 캔버스·사이드바와 같은 유예 큐에 receipt를 넣어야 Undo가 경로에 상관없이 동작한다.
  readonly onDeferredDeletion?: (deletion: DeferredDeletionReceipt | null) => void;
  readonly canUndoLastClose?: () => boolean;
  readonly onUndoLastClose?: () => void;
}

const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const LISTBOX_ID = "operation-search-listbox";
const UNASSIGNED_GROUP_KEY = "__unassigned__";

export function OperationSearch({
  state,
  railPanels,
  plugins,
  onDeferredDeletion,
  canUndoLastClose,
  onUndoLastClose,
}: OperationSearchProps) {
  const t = useT();
  const zenMode = useZenMode();
  const railBindings = useRailEntries();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<PaletteMode>("operations");
  const [text, setText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [railSearchGroups, setRailSearchGroups] = useState<readonly RailSearchGroup[]>([]);
  // 동작 띠가 펼쳐진 Operation 행과 그 안의 선택. 띠는 한 번에 하나만 선다.
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [actionIndex, setActionIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const appliedSeedNonceRef = useRef(0);
  const resultRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchGenerationRef = useRef(0);
  const commandMode = mode === "commands";
  // 사이드바·커맨드 밴드와 같은 마크 축 — 안 본 채 끝난 Operation이 팔레트에서만 침묵하지 않게 한다.
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const entries = useMemo(() => operationSearchEntries(state), [state]);
  const filteredEntries = useMemo(
    () => mode === "operations"
      ? orderOperationSearchEntries(filterOperationSearchEntries(entries, text), state.activeTheaterId, searchTokens(text).length > 0)
      : [],
    [entries, mode, state.activeTheaterId, text],
  );
  const groups = useMemo(() => groupOperationSearchEntries(filteredEntries), [filteredEntries]);
  const undoAvailable = useMemo(() => canUndoLastClose?.() === true, [state.operationSearchOpen, canUndoLastClose]);
  const commands = useMemo(
    () => buildPaletteCommands(state, railPanels, t, { canUndoLastClose: undoAvailable }),
    [state, railPanels, t, undoAvailable, zenMode],
  );
  const recentCommandIds = useMemo(() => readRecentCommandIds(), [state.operationSearchOpen]);
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
    () => railSearchGroups.flatMap((group) => group.results.filter((result) => result.kind !== "info").map((result) => ({ group, result }))),
    [railSearchGroups],
  );
  const primaryCount = mode === "operations" ? filteredEntries.length : matchedCommands.length;
  const resultCount = primaryCount + railSearchEntries.length;
  const clampedSelectedIndex = clampIndex(selectedIndex, resultCount);
  const selectedResultKey = (() => {
    if (clampedSelectedIndex < primaryCount) {
      if (mode === "operations") return operationResultKey(filteredEntries[clampedSelectedIndex]!.operationId);
      return commandRows[clampedSelectedIndex]!.key;
    }
    const rail = railSearchEntries[clampedSelectedIndex - primaryCount];
    return rail ? railResultKey(rail.group.panelId, rail.result.id) : undefined;
  })();
  const activeOptionId = selectedResultKey === undefined ? undefined : resultOptionId(selectedResultKey);
  const selectedOperation = mode === "operations" ? filteredEntries[clampedSelectedIndex] ?? null : null;
  // 탭·범례·힌트의 조합 표기는 등록부의 현재 값이다 — 재배정이 바뀌면 함께 바뀐다.
  useShortcutOverrides();
  const searchShortcut = shortcutCommandLabel("console.search-operations");
  const paletteShortcut = shortcutCommandLabel("console.command-palette");
  const undoShortcut = shortcutCommandLabel("console.undo-close");

  // 패널 내용 검색은 Operation 모드에서만 — 명령 모드는 명령만 보여 주는 편이 손에 맞는다.
  useEffect(() => {
    const generation = ++searchGenerationRef.current;
    setRailSearchGroups([]);
    const theaterId = state.activeTheaterId;
    if (!state.operationSearchOpen || text.trim() === "" || !theaterId || mode !== "operations") return;

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
  }, [mode, text, railPanels, state.activeTheaterId, state.operationSearchOpen, t]);

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

  // seed는 번호가 바뀔 때마다 반영한다 — 열린 창에서 ⌘P를 눌러도 명령 탭으로 옮겨 가야 한다.
  useEffect(() => {
    if (!state.operationSearchOpen) {
      appliedSeedNonceRef.current = 0;
      setMode("operations");
      setText("");
      setSelectedIndex(0);
      setActionsFor(null);
      return;
    }
    if (appliedSeedNonceRef.current === state.operationSearchSeedNonce) return;
    appliedSeedNonceRef.current = state.operationSearchSeedNonce;
    const seed = parsePaletteSeed(state.operationSearchSeed);
    setMode(seed.mode);
    setText(seed.text);
    setSelectedIndex(0);
    setActionsFor(null);
    inputRef.current?.focus();
  }, [state.operationSearchOpen, state.operationSearchSeed, state.operationSearchSeedNonce]);

  useEffect(() => {
    setOperationSearchMode(state.operationSearchOpen ? mode : null);
  }, [mode, state.operationSearchOpen]);

  useEffect(() => {
    setSelectedIndex(0);
    setActionsFor(null);
  }, [mode, text]);

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
    // 폰에는 레일이 없다 — 설정 타깃은 모바일 표현(/settings 페이지)의 같은 섹션으로 보낸다.
    // 아래의 일반 /operations 항해보다 먼저 갈라야 한다: 순서가 뒤면 설정 목록과 상세 사이에
    // /operations 항목이 끼어 Back 제스처가 목록 대신 캔버스로 빠진다.
    if (target && getViewModeSnapshot().effective === "mobile" && target.paneId === SETTINGS_PANE_ID) {
      const section = target.params?.section;
      navigate({ pathname: "/settings", search: section === undefined ? "" : `?section=${encodeURIComponent(section)}` });
      closeOperationSearch();
      return;
    }
    // 경로만 옮기고 주소는 그대로 둔다. `navigate("/operations")`는 쿼리를 함께 버리는데,
    // activate가 방금 기록한 것이 바로 그 쿼리다 — 주소로 문서를 여는 플러그인은 자기가
    // 세운 주소가 이 한 줄에 지워져 아무 일도 일어나지 않는다(실측: 팔레트로 연 Codex 항목).
    navigate({ pathname: "/operations", search: window.location.search });
    // 계약을 따르는 공급자는 열 자리를 값으로 돌려준다. 그 경우 부작용에 기대지 않고 여기서
    // 직접 착지시킨다 — 싱글턴을 쓰지 않는 외부 공급자는 이 경로가 없으면 결과를 열지 못한다.
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
      // 페인을 세우지 않는 엔트리는 레일 패널을 열 수 없다 — 그 엔트리가 여는 것은 표면이다.
      // 여기서 갈라 주지 않으면 팔레트로 고른 결과가 아무 데도 착지하지 않는다.
      const surfaceId = railPanels.find((panel) => panel.id === panelId)?.surfaceId;
      if (surfaceId) openExpandedSurface({ surfaceId });
      else openRailPanel(panelId);
    }
    setRailChromeExpanded(true);
    closeOperationSearch();
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
        // Theater 전환은 캔버스로 포커스 문맥을 넘기므로 selectEntry처럼 이전 포커스 복원을 억제한다.
        previousFocusRef.current = null;
        // 선별 중 수동 전환도 방문 경로를 타야 목적지의 저장된 Formation/companion이 부활하지 않는다.
        if (isTriageActive()) visitTriageTheater(action.theaterId);
        else setActiveTheater(action.theaterId);
        navigate("/operations");
        break;
      }
      case "new-theater": {
        setZenMode(false);
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
        if (action.surfaceId) openExpandedSurface({ surfaceId: action.surfaceId });
        else openRailPanel(action.panelId);
        setRailChromeExpanded(true);
        break;
      }
      case "toggle-zen": {
        if (getViewModeSnapshot().effective === "mobile") break;
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        const target = previousFocusRef.current;
        previousFocusRef.current = null;
        toggleZenMode();
        requestAnimationFrame(() => {
          if (target?.isConnected && !target.closest("[inert], [hidden]")) target.focus({ preventScroll: true });
          else document.querySelector<HTMLElement>(".operations-center-stage")?.focus({ preventScroll: true });
        });
        break;
      }
      case "toggle-rail": {
        setZenMode(false);
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        // 구 복원 좌표(밴드 rail 토글)는 퇴역했다 — 복원을 억제하고 도착지가 받는다: 접히면
        // 엣지 독, 펼치면 레일의 접기 컨트롤. 두 좌표 모두 이 커밋의 재렌더 뒤에야 서므로
        // 프레임을 하나 넘긴다(open-settings와 같은 계약, 미발견 시 포커스 생략).
        previousFocusRef.current = null;
        const railCollapsing = getRailStoreSnapshot().railChromeExpanded;
        toggleRailChrome();
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(railCollapsing ? ".rail-edge-dock" : ".right-rail-collapse")?.focus();
        });
        break;
      }
      case "toggle-sidebar": {
        setZenMode(false);
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        // toggle-rail과 같은 도착지 포커스 계약 — 접히면 엣지 독, 펼치면 사이드바의 접기 컨트롤.
        previousFocusRef.current = null;
        const sideBarCollapsing = !getSideBarState().collapsed;
        setSideBarCollapsed(sideBarCollapsing);
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(sideBarCollapsing ? ".side-bar-edge-dock" : ".side-bar-collapse")?.focus();
        });
        break;
      }
      case "toggle-command-band-dock": {
        toggleCommandBandDocked();
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
        setZenMode(false);
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
        setZenMode(false);
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
      case "open-commissioning": {
        // 팔레트가 닫히면서 오버레이가 열리므로 오버레이가 보는 activeElement는 제거 중인 팔레트 내부다.
        // 팔레트를 연 시점의 요소를 채널로 넘겨 가이드가 닫힐 때 그 요소로 복원되게 한다.
        stashCommissioningReturnFocus(previousFocusRef.current);
        previousFocusRef.current = null;
        openOnboarding();
        break;
      }
    }
    closeOperationSearch();
  };

  const runCommand = (command: PaletteCommandEntry) => {
    noteCommandRun(command.commandId);
    runAction(command.action, command.current);
  };

  // Operation 행의 동작 띠. 정의는 명령 팔레트의 액션과 같다 — 같은 일이 두 자리에 서도 한 경로로 간다.
  const rowActions = (entry: OperationSearchEntry): readonly RowAction[] => {
    const actions: RowAction[] = [
      { id: "open", label: t("chrome.operationSearch.actionOpen"), glyph: "operation-open", run: () => selectEntry(entry.operationId) },
    ];
    if (entry.activity === "ended") {
      actions.push({ id: "resume", label: t("chrome.operationSearch.actionResume"), glyph: "operation-resume", run: () => runAction({ kind: "resume-operation", operationId: entry.operationId }, false) });
    }
    // 이름 변경·최소화는 사이드바가 소비하는 요청이다. 모바일 셸에는 사이드바가 없어 요청이 아무 데도
    // 닿지 않고 나중에 데스크톱 사이드바가 서면 뒤늦게 재생되므로, 그 표면에서는 띠에 올리지 않는다.
    if (getViewModeSnapshot().effective !== "mobile") {
      actions.push(
        { id: "rename", label: t("chrome.operationSearch.actionRename"), glyph: "operation-rename", run: () => runAction({ kind: "rename-operation", operationId: entry.operationId }, false) },
        { id: "minimize", label: t("chrome.operationSearch.actionMinimize"), glyph: "operation-minimize", run: () => runAction({ kind: "minimize-operation", operationId: entry.operationId }, false) },
      );
    }
    actions.push({ id: "close", label: t("chrome.operationSearch.actionClose"), glyph: "operation-close", danger: true, run: () => runAction({ kind: "close-operation", operationId: entry.operationId }, false) });
    return actions;
  };

  const activateSelected = () => {
    if (clampedSelectedIndex < primaryCount) {
      if (mode === "operations") {
        const selected = filteredEntries[clampedSelectedIndex];
        if (!selected) return;
        if (actionsFor === selected.operationId) rowActions(selected)[actionIndex]?.run();
        else selectEntry(selected.operationId);
        return;
      }
      const selected = matchedCommands[clampedSelectedIndex];
      if (selected) runCommand(selected.command);
      return;
    }
    const panelEntry = railSearchEntries[clampedSelectedIndex - primaryCount];
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
    const prefixMode = text === "" && mode === "operations" ? paletteModeForPrefix(value[0] ?? "") : null;
    if (prefixMode) {
      setMode(prefixMode);
      setText(value.slice(1));
      return;
    }
    setText(value);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (actionsFor !== null) setActionsFor(null);
      else closeOperationSearch();
      return;
    }
    if (event.key === "Backspace" && text === "" && mode !== "operations") {
      event.preventDefault();
      switchMode("operations");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActionsFor(null);
      setSelectedIndex((current) => clampIndex(current + (event.key === "ArrowDown" ? 1 : -1), resultCount));
      return;
    }
    if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && selectedOperation) {
      const input = inputRef.current;
      // 캐럿이 글 가운데면 화살표는 글 편집이다 — 띠는 캐럿이 끝(→)·처음(←)에 있을 때만 받는다.
      const caretAtEdge = !input || (event.key === "ArrowRight" ? input.selectionEnd === input.value.length : input.selectionStart === 0);
      if (!caretAtEdge && actionsFor === null) return;
      event.preventDefault();
      const actions = rowActions(selectedOperation);
      if (event.key === "ArrowRight") {
        if (actionsFor === selectedOperation.operationId) setActionIndex((current) => Math.min(current + 1, actions.length - 1));
        else {
          setActionsFor(selectedOperation.operationId);
          setActionIndex(0);
        }
      } else if (actionsFor === selectedOperation.operationId) {
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

  const placeholder = t(mode === "commands" ? "chrome.operationSearch.placeholderCommands" : "chrome.operationSearch.placeholderOperations");
  const emptyMessage = t(mode === "commands" ? "chrome.operationSearch.noMatchingCommands" : "chrome.operationSearch.noMatching");
  const sectionTitle = (id: "recent" | PaletteCommandGroup | "matches"): string => {
    switch (id) {
      case "recent": return t("chrome.operationSearch.sectionRecent");
      case "current-operation": {
        const active = state.operations.find((operation) => operation.id === state.activeOperationId);
        return active ? `${t("chrome.operationSearch.sectionCurrentOperation")} · ${active.title}` : t("chrome.operationSearch.sectionCurrentOperation");
      }
      case "theater": return t("chrome.operationSearch.sectionTheater");
      case "view": return t("chrome.operationSearch.sectionView");
      case "panel": return t("chrome.operationSearch.sectionPanel");
      case "console": return t("chrome.operationSearch.sectionConsole");
      case "matches": return t("chrome.operationSearch.commands");
    }
  };

  const renderRailGroups = (offset: number) => railSearchGroups.map((group) => {
    const headingId = railGroupHeadingId(group.panelId);
    const panelIcon = railPanels.find((panel) => panel.id === group.panelId)?.icon;
    return (
      <section className="operation-search-section operation-search-panel-section" key={group.panelId} role="group" aria-labelledby={headingId}>
        <h2 id={headingId} className="operation-search-section-heading">{group.panelTitle}</h2>
        {group.results.map((result) => {
          const index = offset + railSearchEntries.findIndex((entry) => entry.group.panelId === group.panelId && entry.result === result);
          const active = index === clampedSelectedIndex;
          const resultKey = railResultKey(group.panelId, result.id);
          if (result.kind === "info") {
            // 읽기 전용 표식 행 — option 역할·활성화·"열기" 어포던스를 모두 붙이지 않는다.
            return (
              <div key={result.id} className="operation-search-result operation-search-panel-info">
                <span className="operation-search-result-text operation-search-result-text-inline">
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
              className={`operation-search-result operation-search-panel-result ${active ? "is-active" : ""}`}
              role="option"
              aria-selected={active}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => { void selectRailResult(group.panelId, result); }}
            >
              <PaletteRailIcon icon={panelIcon} />
              {/* 패널 결과도 한 줄이다 — 부제(경로·태그)는 제목 오른쪽에 조용한 메타로 서고,
                  제목과 같은 부제(파일명 = 상대 경로)는 반복하지 않는다. */}
              <span className="operation-search-result-text operation-search-result-text-inline">
                <strong>{highlightText(result.title, tokens)}</strong>
                {panelSubtitle(result) ? <small>{highlightText(panelSubtitle(result)!, tokens)}</small> : null}
              </span>
              <span className="operation-search-panel-open">{t("chrome.operationSearch.open")}</span>
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
          <div className="operation-search-switch" role="tablist" aria-label={t("chrome.operationSearch.switchAria")}>
            {PALETTE_MODES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                className={`operation-search-switch-option${candidate === mode ? " is-active" : ""}`}
                aria-selected={candidate === mode}
                tabIndex={-1}
                title={candidate === "operations" ? searchShortcut : paletteShortcut}
                onClick={() => switchMode(candidate)}
              >
                {t(candidate === "operations" ? "chrome.operationSearch.tabOperations" : "chrome.operationSearch.tabCommands")}
                <kbd>{candidate === "operations" ? searchShortcut : paletteShortcut}</kbd>
              </button>
            ))}
          </div>
        </div>
        <div id={LISTBOX_ID} className="operation-search-results" role="listbox" aria-label={commandMode ? t("chrome.operationSearch.commandResults") : t("chrome.operationSearch.operationResults")}>
          {!hasResults ? (
            <p className="operation-search-empty">
              {emptyMessage}
              {mode === "operations" ? <span className="operation-search-empty-hint">{t("chrome.operationSearch.noMatchingOperationsHint", { shortcut: paletteShortcut })}</span> : null}
            </p>
          ) : mode !== "operations" ? (
            <>
              {commandSections.map((section) => {
                const headingId = commandSectionHeadingId(section.id);
                return (
                  <section className="operation-search-section" key={section.id} role="group" aria-labelledby={headingId}>
                    <h2 id={headingId} className="operation-search-section-heading">
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
                          className={`operation-search-result${active ? " is-active" : ""}${command.danger ? " is-danger" : ""}`}
                          role="option"
                          aria-selected={active}
                          onMouseEnter={() => setSelectedIndex(index)}
                          onClick={() => runCommand(command)}
                        >
                          <PaletteCommandGlyph command={command} />
                          <span className="operation-search-result-text">
                            <strong>{highlightIndices(command.label, scored.matchedIndices)}</strong>
                          </span>
                          {command.current ? <span className="operation-search-theater">{t("chrome.operationSearch.current")}</span> : null}
                          {command.undoable ? <span className="operation-search-undoable">{t("chrome.operationSearch.undoable", { shortcut: undoShortcut })}</span> : null}
                          {command.shortcut ? <span className="operation-search-shortcut">{chordKeyLabels(resolveShortcutChords(command.shortcut)[0] ?? "").map((key, keyIndex) => <kbd key={`${keyIndex}:${key}`}>{key}</kbd>)}</span> : null}
                        </button>
                      );
                    })}
                  </section>
                );
              })}
              {renderRailGroups(matchedCommands.length)}
            </>
          ) : (
            <>
              {groups.map((group) => {
                const headingId = operationGroupHeadingId(group.theaterId);
                const activeGroup = group.theaterId === state.activeTheaterId;
                return (
                  <section className="operation-search-section" key={group.theaterId ?? UNASSIGNED_GROUP_KEY} role="group" aria-labelledby={headingId}>
                    <h2 id={headingId} className="operation-search-section-heading">
                      {highlightText(group.theaterLabel, tokens)}
                      {activeGroup ? <span className="operation-search-section-note">{t("chrome.operationSearch.current")}</span> : null}
                    </h2>
                    {group.entries.map((entry) => {
                      const index = filteredEntries.indexOf(entry);
                      const active = index === clampedSelectedIndex;
                      const resultKey = operationResultKey(entry.operationId);
                      const stripOpen = actionsFor === entry.operationId;
                      const actions = stripOpen ? rowActions(entry) : [];
                      return (
                        <div key={entry.operationId} className={`operation-search-row${stripOpen ? " has-actions" : ""}`}>
                          <button
                            id={resultOptionId(resultKey)}
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
                                마크가 항상 서므로 제목 열이 어긋나지 않는다. 공급자·Theater는 행에 반복하지
                                않는다 — Theater는 구역 머리글이, 공급자는 사이드바가 이미 말한다. */}
                            <span className="operation-search-op-mark">
                              <OperationNameMark
                                operation={entry}
                                status={resolveOperationMarkVisual({ activity: entry.activity, operationId: entry.operationId, idleArrivalIds })}
                              />
                            </span>
                            <span className="operation-search-result-text">
                              <strong>{highlightText(entry.operationName, tokens)}</strong>
                            </span>
                            <span className="operation-search-row-arrow" aria-hidden="true">{stripOpen ? "◂" : "▸"}</span>
                          </button>
                          {stripOpen ? (
                            <div className="operation-search-actions" role="group" aria-label={t("chrome.operationSearch.actionsAria", { title: entry.operationName })}>
                              {actions.map((action, i) => (
                                <button
                                  key={action.id}
                                  type="button"
                                  tabIndex={-1}
                                  className={`operation-search-action${i === actionIndex ? " is-active" : ""}${action.danger ? " is-danger" : ""}`}
                                  onMouseEnter={() => setActionIndex(i)}
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
              {renderRailGroups(filteredEntries.length)}
            </>
          )}
        </div>
        <div className="operation-search-legend">
          <span><kbd>↑</kbd><kbd>↓</kbd>{t("chrome.operationSearch.legendMove")}</span>
          <span><kbd>↵</kbd>{t(mode === "operations" ? "chrome.operationSearch.legendOpen" : "chrome.operationSearch.legendRun")}</span>
          {mode === "operations" ? <span><kbd>→</kbd>{t("chrome.operationSearch.legendActions")}</span> : null}
          <span><kbd>esc</kbd>{t("chrome.operationSearch.legendClose")}</span>
          <span className="operation-search-legend-switch">{t(mode === "operations" ? "chrome.operationSearch.legendToCommands" : "chrome.operationSearch.legendToOperations", { shortcut: mode === "operations" ? paletteShortcut : searchShortcut })}</span>
        </div>
      </section>
    </div>
  );
}

interface RowAction {
  readonly id: string;
  readonly label: string;
  readonly glyph: "operation-open" | "operation-resume" | "operation-rename" | "operation-minimize" | "operation-close";
  readonly danger?: boolean;
  readonly run: () => void;
}

function commandSectionHeadingId(id: string): string {
  return `operation-search-heading-commands-${domIdPart(id)}`;
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

function panelSubtitle(result: { readonly title: string; readonly subtitle?: string | null }): string | null {
  const subtitle = result.subtitle?.trim();
  return subtitle && subtitle !== result.title.trim() ? subtitle : null;
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
