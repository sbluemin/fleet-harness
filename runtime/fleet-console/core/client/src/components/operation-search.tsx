import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

import { setGlobalSettingsField } from "../global-settings-store.js";
import { filterOperationSearchEntries, groupOperationSearchEntries, searchTokens } from "../operation-search.js";
import {
  buildPaletteCommands,
  commandModeQuery,
  filterPaletteCommands,
  isCommandModeInput,
  type PaletteCommandEntry,
  type PaletteRailPanelInfo,
} from "../palette-commands.js";
import { stashKeyboardShortcutsReturnFocus } from "../keyboard-shortcuts-return-focus.js";
import { closeOperationCompletely } from "../operation-close.js";
import { getLoadedTheaterId, ensureDefaultGeometry, forceDropCompanionOperationId, getCompanionOperationId, loadForTheater, minimizeOperations, toggleFormationView } from "../canvas/canvas-store.js";
import { openRailPanel, setRailChromeExpanded, toggleRailChrome } from "../rail/rail-store.js";
import { getSideBarState, setSideBarCollapsed, toggleSideBarStatusAxis } from "../sidebar/operations-side-bar-store.js";
import {
  closeOperationSearch,
  focusOperation,
  openKeyboardShortcuts,
  openWhatsNew,
  operationSearchEntries,
  requestOperationLaunchMenu,
  setActiveTheater,
  setActiveTheme,
} from "../store.js";
import type { ConsoleState } from "../types.js";

interface OperationSearchProps {
  readonly state: ConsoleState;
  readonly railPanels: readonly PaletteRailPanelInfo[];
  // virtual:fleet-plugins 의존을 테스트 경계 밖으로 밀기 위해 registry 직접 import 대신 prop으로 받는다.
  readonly plugins: readonly FleetClientPlugin[];
}

const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const LISTBOX_ID = "operation-search-listbox";
const UNASSIGNED_GROUP_KEY = "__unassigned__";
const COMMAND_GROUP_HEADING_ID = "operation-search-heading-commands";

export function OperationSearch({ state, railPanels, plugins }: OperationSearchProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const resultRefs = useRef(new Map<string, HTMLButtonElement>());
  const commandMode = isCommandModeInput(query);
  const entries = useMemo(() => operationSearchEntries(state), [state]);
  const filteredEntries = useMemo(() => filterOperationSearchEntries(entries, query), [entries, query]);
  const groups = useMemo(() => groupOperationSearchEntries(filteredEntries), [filteredEntries]);
  const commands = useMemo(() => buildPaletteCommands(state, railPanels), [state, railPanels]);
  const filteredCommands = useMemo(
    () => (commandMode ? filterPaletteCommands(commands, commandModeQuery(query)) : commands),
    [commandMode, commands, query],
  );
  const tokens = useMemo(() => searchTokens(commandMode ? commandModeQuery(query) : query), [commandMode, query]);
  const resultCount = commandMode ? filteredCommands.length : filteredEntries.length;
  const clampedSelectedIndex = clampIndex(selectedIndex, resultCount);
  const selectedResultKey = commandMode
    ? filteredCommands[clampedSelectedIndex]?.commandId
    : filteredEntries[clampedSelectedIndex]?.operationId;
  const activeOptionId = selectedResultKey === undefined
    ? undefined
    : commandMode ? commandOptionId(selectedResultKey) : operationOptionId(selectedResultKey);

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

  const runCommand = (command: PaletteCommandEntry) => {
    const action = command.action;
    switch (action.kind) {
      case "switch-theater": {
        if (command.current) break;
        // Theater 전환은 캔버스로 포커스 문맥을 넘기므로 selectEntry처럼 이전 포커스 복원을 억제한다.
        previousFocusRef.current = null;
        setActiveTheater(action.theaterId);
        navigate("/operations");
        break;
      }
      case "new-operation": {
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        requestOperationLaunchMenu();
        break;
      }
      case "resume-operation": {
        // plugin이 resumeOperation 훅을 제공하면 직접 재개하고, 미제공 시에만 프레임 포커스로 폭백한다.
        // 실패 시에는 포커스하지 않는다 — focusOperation은 알림을 제거하므로(store.ts) plugin이 emit한
        // agent.resume-failed가 지워져 침묵 실패가 된다. 실패 피드백은 칩 뱃지 + Alerts 항목이 담당한다.
        previousFocusRef.current = null;
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        const operation = state.operations.find((op) => op.id === action.operationId);
        const plugin = operation ? plugins.find((candidate) => candidate.id === operation.pluginId) : undefined;
        if (plugin?.resumeOperation) {
          void Promise.resolve(plugin.resumeOperation(action.operationId)).catch(() => { /* 실패 알림은 plugin이 emit */ });
        } else {
          focusOperation(action.operationId);
        }
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
        void closeOperationCompletely(action.operationId, plugin);
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
        for (const operation of theaterOperations) ensureDefaultGeometry(operation.id);
        minimizeOperations(theaterOperations.map((op) => op.id));
        break;
      }
      case "toggle-formation": {
        if (!location.pathname.startsWith("/operations")) navigate("/operations");
        ensurePaletteCanvasTheater(state);
        toggleFormationView();
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
        // 라우트 전환으로 이전 포커스 요소가 unmount되므로 복원을 억제한다(switch-theater와 동일).
        previousFocusRef.current = null;
        navigate("/settings");
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
      case "whats-new": {
        openWhatsNew();
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
        const selected = filteredCommands[clampedSelectedIndex];
        if (!selected) return;
        event.preventDefault();
        runCommand(selected);
        return;
      }
      const selected = filteredEntries[clampedSelectedIndex];
      if (!selected) return;
      event.preventDefault();
      selectEntry(selected.operationId);
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
        aria-label={commandMode ? "Console commands" : "Operation quick search"}
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
            placeholder="Search Operations — type > for commands"
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
        <div id={LISTBOX_ID} className="operation-search-results" role="listbox" aria-label={commandMode ? "Command results" : "Operation results"}>
          {commandMode ? (filteredCommands.length > 0 ? (
            <section className="operation-search-section" role="group" aria-labelledby={COMMAND_GROUP_HEADING_ID}>
              <h2 id={COMMAND_GROUP_HEADING_ID} className="operation-search-section-heading">Commands</h2>
              {filteredCommands.map((command, index) => {
                const active = index === clampedSelectedIndex;
                return (
                  <button
                    id={commandOptionId(command.commandId)}
                    key={command.commandId}
                    ref={(node) => {
                      if (node) resultRefs.current.set(command.commandId, node);
                      else resultRefs.current.delete(command.commandId);
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
                      <strong>{highlightText(command.label, tokens)}</strong>
                    </span>
                    {command.current ? <span className="operation-search-theater">current</span> : null}
                  </button>
                );
              })}
            </section>
          ) : <p className="operation-search-empty">No matching commands.</p>) : groups.length > 0 ? groups.map((group) => {
            const headingId = operationGroupHeadingId(group.theaterId);
            return (
            <section className="operation-search-section" key={group.theaterId ?? UNASSIGNED_GROUP_KEY} role="group" aria-labelledby={headingId}>
              <h2 id={headingId} className="operation-search-section-heading">{highlightText(group.theaterLabel, tokens)}</h2>
              {group.entries.map((entry) => {
                const index = filteredEntries.indexOf(entry);
                const active = index === clampedSelectedIndex;
                return (
                  <button
                    id={operationOptionId(entry.operationId)}
                    key={entry.operationId}
                    ref={(node) => {
                      if (node) resultRefs.current.set(entry.operationId, node);
                      else resultRefs.current.delete(entry.operationId);
                    }}
                    type="button"
                    className={`operation-search-result ${active ? "is-active" : ""}`}
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => selectEntry(entry.operationId)}
                  >
                    <span className="operation-search-result-text">
                      <strong>{highlightText(entry.operationName, tokens)}</strong>
                      <small>{operationMeta(entry)}</small>
                    </span>
                    {entry.activity !== "idle" ? (
                      <span className={`operation-search-status operation-search-status--${entry.activity}`}>{entry.activity}</span>
                    ) : null}
                    <span className="operation-search-theater">{highlightText(entry.theaterLabel, tokens)}</span>
                  </button>
                );
              })}
            </section>
            );
          }) : <p className="operation-search-empty">No matching Operations.</p>}
        </div>
      </section>
    </div>
  );
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

function operationMeta(entry: { readonly pluginId: string; readonly status: string }): string {
  return [entry.pluginId, entry.status].filter(Boolean).join(" · ");
}

function operationGroupHeadingId(theaterId: string | null): string {
  return `operation-search-heading-${domIdPart(theaterId ?? UNASSIGNED_GROUP_KEY)}`;
}

function operationOptionId(operationId: string): string {
  return `operation-search-option-${domIdPart(operationId)}`;
}

function commandOptionId(commandId: string): string {
  return `operation-search-command-${domIdPart(commandId)}`;
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
