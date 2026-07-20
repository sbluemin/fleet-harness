import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { filterOperationSearchEntries, groupOperationSearchEntries, searchTokens } from "../operation-search.js";
import { closeOperationSearch, focusOperation, operationSearchEntries } from "../store.js";
import type { ConsoleState } from "../types.js";

interface OperationSearchProps {
  readonly state: ConsoleState;
}

const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const LISTBOX_ID = "operation-search-listbox";
const UNASSIGNED_GROUP_KEY = "__unassigned__";

export function OperationSearch({ state }: OperationSearchProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const resultRefs = useRef(new Map<string, HTMLButtonElement>());
  const entries = useMemo(() => operationSearchEntries(state), [state]);
  const filteredEntries = useMemo(() => filterOperationSearchEntries(entries, query), [entries, query]);
  const groups = useMemo(() => groupOperationSearchEntries(filteredEntries), [filteredEntries]);
  const tokens = useMemo(() => searchTokens(query), [query]);
  const clampedSelectedIndex = clampIndex(selectedIndex, filteredEntries.length);
  const activeOptionId = filteredEntries[clampedSelectedIndex] ? operationOptionId(filteredEntries[clampedSelectedIndex].operationId) : undefined;

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
    if (!state.operationSearchOpen) return;
    const selected = filteredEntries[clampedSelectedIndex];
    if (!selected) return;
    resultRefs.current.get(selected.operationId)?.scrollIntoView({ block: "nearest" });
  }, [clampedSelectedIndex, filteredEntries, state.operationSearchOpen]);

  if (!state.operationSearchOpen) return null;

  const selectEntry = (operationId: string) => {
    // 선택은 대상 Operation으로 키보드 포커스를 넘기므로 닫힘 cleanup이 이전 UI 포커스를 되찾지 않게 한다.
    previousFocusRef.current = null;
    // 최대화 해제는 이동 경로(operations.tsx의 pendingOperationFocus 소비)에 위임한다 — 최대화 중이면 유지·교체.
    focusOperation(operationId);
    navigate("/operations");
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
      setSelectedIndex((current) => clampIndex(current + (event.key === "ArrowDown" ? 1 : -1), filteredEntries.length));
      return;
    }
    if (event.key === "Enter") {
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
        aria-label="Operation quick search"
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
            placeholder="Search Operations across Theaters"
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
        <div id={LISTBOX_ID} className="operation-search-results" role="listbox" aria-label="Operation results">
          {groups.length > 0 ? groups.map((group) => {
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

function operationMeta(entry: { readonly pluginId: string; readonly status: string }): string {
  return [entry.pluginId, entry.status].filter(Boolean).join(" · ");
}

function operationGroupHeadingId(theaterId: string | null): string {
  return `operation-search-heading-${domIdPart(theaterId ?? UNASSIGNED_GROUP_KEY)}`;
}

function operationOptionId(operationId: string): string {
  return `operation-search-option-${domIdPart(operationId)}`;
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
