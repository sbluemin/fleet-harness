import type { SearchAddon } from "@xterm/addon-search";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { useEffect, useRef, useState } from "react";

import { getT } from "../../agent/i18n/index.js";
import "./terminal-search.css";

/**
 * 터미널 안 찾기. 렌더러가 캔버스라 브라우저 찾기로는 출력 글자를 찾을 수 없다.
 *
 * Enter는 다음, Shift+Enter는 이전, Esc는 닫기다. 닫으면 강조를 지우고 터미널로 포커스를 돌려준다.
 */
export function TerminalSearchBar({ search, locale, onClose }: {
  readonly search: SearchAddon;
  readonly locale?: ConsoleLocale;
  readonly onClose: () => void;
}) {
  const t = getT(locale);
  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<{ readonly index: number; readonly count: number } | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const subscription = search.onDidChangeResults((event) => setResults({ index: event.resultIndex, count: event.resultCount }));
    return () => {
      subscription.dispose();
      search.clearDecorations();
    };
  }, [search]);

  const run = (direction: "next" | "previous", value = term, incremental = false) => {
    if (!value) {
      search.clearDecorations();
      setResults(null);
      return;
    }
    const options = { decorations: readSearchDecorations(), ...(incremental ? { incremental: true } : {}) };
    if (direction === "next") search.findNext(value, options);
    else search.findPrevious(value, options);
  };

  const status = results === null
    ? ""
    : results.count === 0
      ? t("terminal.search.noResults")
      : results.index < 0
        ? t("terminal.search.manyResults", { count: results.count })
        : t("terminal.search.position", { current: results.index + 1, count: results.count });

  return (
    <div className="terminal-search-bar" role="search">
      <input
        ref={inputRef}
        className="terminal-search-input"
        type="text"
        value={term}
        spellCheck={false}
        placeholder={t("terminal.search.placeholder")}
        aria-label={t("terminal.search.aria")}
        onChange={(event) => {
          setTerm(event.target.value);
          run("next", event.target.value, true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            run(event.shiftKey ? "previous" : "next");
          }
        }}
      />
      <span className="terminal-search-status" aria-live="polite">{status}</span>
      <button type="button" className="terminal-search-button" aria-label={t("terminal.search.previous")} title={t("terminal.search.previous")} onClick={() => run("previous")}>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button type="button" className="terminal-search-button" aria-label={t("terminal.search.next")} title={t("terminal.search.next")} onClick={() => run("next")}>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button type="button" className="terminal-search-button" aria-label={t("terminal.search.close")} title={t("terminal.search.close")} onClick={onClose}>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

/** ⌘F(macOS) · Ctrl+Shift+F(그 밖). 맨 Ctrl+F는 셸의 한 글자 앞으로(readline)라 가로채지 않는다. */
export function isTerminalSearchShortcut(event: KeyboardEvent, isMac: boolean): boolean {
  if (event.type !== "keydown" || event.altKey || event.key.toLowerCase() !== "f") return false;
  return isMac
    ? event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey;
}

/**
 * 찾기 강조색. xterm은 #RRGGBB만 받으므로 테마 토큰(위치·포커스 채널인 brass)을 계산값으로 읽어
 * 캔버스로 16진 정규화한다 — 테마를 바꾸면 다음 찾기부터 새 색을 쓴다.
 */
function readSearchDecorations() {
  const brass = readTokenHex("--brass", "#c8a14a");
  const rim = readTokenHex("--surface-rim-strong", "#4a5560");
  return {
    matchBackground: rim,
    matchBorder: rim,
    matchOverviewRuler: rim,
    activeMatchBackground: brass,
    activeMatchBorder: brass,
    activeMatchColorOverviewRuler: brass,
  };
}

let normalizer: CanvasRenderingContext2D | null = null;

function readTokenHex(token: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (!value) return fallback;
  normalizer ??= document.createElement("canvas").getContext("2d");
  if (!normalizer) return fallback;
  normalizer.fillStyle = fallback;
  normalizer.fillStyle = value;
  const normalized = normalizer.fillStyle;
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized;
  // 알파가 섞인 값은 rgba()로 돌아온다 — 1×1 픽셀에 칠해 불투명 RGB만 취한다.
  normalizer.clearRect(0, 0, 1, 1);
  normalizer.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = normalizer.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
