import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { FileExplorerMessageKey } from "../i18n/index.js";
import { tokenize } from "../syntax/highlighter.js";

/** Matches `.fexp-code-row` height (13px --t-md × 1.6, rounded). */
const CODE_LINE_HEIGHT_PX = 21;
const CODE_OVERSCAN_LINES = 8;
/**
 * 줄바꿈을 켜면 한 줄의 높이가 내용에 따라 달라져 고정 높이 가상화의 인덱스↔스크롤 대응이 깨진다
 * (실측: 1,200줄 파일에서 끝까지 스크롤해도 1039행에서 멈춤). 그래서 줄바꿈 모드는 창을 나누지 않고
 * 전부 그리며, 그것이 감당 가능한 줄 수까지만 줄바꿈을 허용한다.
 */
export const WRAP_LINE_BUDGET = 2000;

export function canWrapLines(lineCount: number): boolean {
  return lineCount <= WRAP_LINE_BUDGET;
}

interface CodeViewerProps {
  readonly content: string;
  readonly lang: string;
  readonly truncated?: boolean;
  readonly wrap?: boolean;
  readonly target?: {
    readonly lineNumber: number;
    readonly ranges: readonly { readonly start: number; readonly end: number }[];
  };
  readonly t: Translate<FileExplorerMessageKey>;
}

export function visibleLineWindow(
  scrollTop: number,
  viewportHeight: number,
  lineCount: number,
  lineHeight: number = CODE_LINE_HEIGHT_PX,
  overscan: number = CODE_OVERSCAN_LINES,
): { readonly start: number; readonly end: number; readonly offsetY: number; readonly totalHeight: number } {
  const totalHeight = Math.max(0, lineCount * lineHeight);
  if (lineCount === 0) return { start: 0, end: 0, offsetY: 0, totalHeight: 0 };
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / lineHeight) - overscan);
  const end = Math.min(
    lineCount,
    Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / lineHeight) + overscan,
  );
  return { start, end, offsetY: start * lineHeight, totalHeight };
}

export function CodeViewer({ content, lang, truncated, wrap = false, target, t }: CodeViewerProps) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const wrapping = wrap && canWrapLines(lines.length);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const measure = () => setViewportHeight(node.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !target) return;
    if (wrapping) {
      // wrap 행은 가변 높이라 수식으로 좌표를 만들 수 없다. 전체 렌더 뒤 실제 target 행을 맞춘다.
      const frame = window.requestAnimationFrame(() => {
        windowRef.current?.querySelector<HTMLElement>(".is-search-target")?.scrollIntoView({ block: "center" });
      });
      return () => window.cancelAnimationFrame(frame);
    }
    const targetTop = Math.max(0, (target.lineNumber - 1) * CODE_LINE_HEIGHT_PX - node.clientHeight * 0.35);
    node.scrollTop = targetTop;
    setScrollTop(targetTop);
  }, [target?.lineNumber, wrapping]);

  const windowed = visibleLineWindow(scrollTop, viewportHeight, lines.length);
  // 줄바꿈 모드는 창을 나누지 않는다 — 가변 높이를 고정 높이 격자에 얹으면 뒷줄이 도달 불가가 된다.
  const { start, end, offsetY, totalHeight } = wrapping
    ? { start: 0, end: lines.length, offsetY: 0, totalHeight: 0 }
    : windowed;
  const rendered = useMemo(() => {
    return lines.slice(start, end).map((line) => renderLine(line, lang));
  }, [lang, lines, start, end]);
  const rows = rendered.map((html, index) => {
    const lineNumber = start + index + 1;
    return (
      <CodeRow
        key={start + index}
        lineNumber={lineNumber}
        html={html}
        target={lineNumber === target?.lineNumber ? target : undefined}
        rawLine={lines[start + index] ?? ""}
        lang={lang}
      />
    );
  });

  return (
    <div className={`fexp-code-wrap${wrapping ? " is-wrap" : ""}`}>
      {truncated && <div className="fexp-truncated-badge">{t("fileExplorer.viewer.truncated")}</div>}
      <div
        ref={scrollRef}
        className="fexp-code-scroll"
        role="region"
        aria-label={t("fileExplorer.viewer.fileContentsAria")}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {wrapping ? (
          <div className="fexp-code-sizer">
            <div className="fexp-code-window" ref={windowRef}>
              {rows}
            </div>
          </div>
        ) : (
          <div className="fexp-code-sizer" style={{ height: totalHeight }}>
            <div className="fexp-code-window" ref={windowRef} style={{ transform: `translateY(${offsetY}px)` }}>
              {rows}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CodeRow({
  lineNumber,
  html,
  target,
  rawLine,
  lang,
}: {
  readonly lineNumber: number;
  readonly html: string;
  readonly target?: { readonly ranges: readonly { readonly start: number; readonly end: number }[] };
  readonly rawLine: string;
  readonly lang: string;
}) {
  const highlighted = target ? renderLineWithSearchRanges(rawLine, lang, target.ranges) : html;
  return (
    <div className={`fexp-code-row${target ? " is-search-target" : ""}`}>
      <span className="fexp-line-num" aria-hidden="true">{lineNumber}</span>
      <span
        className="fexp-line-code"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </div>
  );
}

function renderLine(line: string, lang: string): string {
  if (lang === "plaintext" || lang === "markdown") return escapeHtml(line) || " ";
  const tokens = tokenize(line, lang);
  return tokens.map((tok) => {
    const escaped = escapeHtml(tok.value);
    return tok.kind === "text" ? escaped : `<span class="syn-${tok.kind}">${escaped}</span>`;
  }).join("") || " ";
}

export function renderLineWithSearchRanges(
  line: string,
  lang: string,
  ranges: readonly { readonly start: number; readonly end: number }[],
): string {
  const normalized = [...ranges]
    .filter((range) => range.start >= 0 && range.end > range.start && range.end <= line.length)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (normalized.length === 0) return renderLine(line, lang);
  let cursor = 0;
  let rendered = "";
  for (const range of normalized) {
    if (range.start < cursor) continue;
    rendered += renderLine(line.slice(cursor, range.start), lang);
    rendered += `<mark class="fexp-code-search-mark">${escapeHtml(line.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  rendered += renderLine(line.slice(cursor), lang);
  return rendered || " ";
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
