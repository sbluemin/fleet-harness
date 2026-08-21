import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { FileExplorerMessageKey } from "../i18n/index.js";
import { tokenize } from "../syntax/highlighter.js";

/** Matches `.fexp-code-row` height (13px --t-md × 1.6, rounded). */
export const CODE_LINE_HEIGHT_PX = 21;
export const CODE_OVERSCAN_LINES = 8;

interface CodeViewerProps {
  readonly content: string;
  readonly lang: string;
  readonly truncated?: boolean;
  readonly wrap?: boolean;
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

export function CodeViewer({ content, lang, truncated, wrap = false, t }: CodeViewerProps) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);

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

  const { start, end, offsetY, totalHeight } = visibleLineWindow(scrollTop, viewportHeight, lines.length);
  const rendered = useMemo(() => {
    return lines.slice(start, end).map((line) => renderLine(line, lang));
  }, [lang, lines, start, end]);

  return (
    <div className={`fexp-code-wrap${wrap ? " is-wrap" : ""}`}>
      {truncated && <div className="fexp-truncated-badge">{t("fileExplorer.viewer.truncated")}</div>}
      <div
        ref={scrollRef}
        className="fexp-code-scroll"
        role="region"
        aria-label={t("fileExplorer.viewer.fileContentsAria")}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {wrap ? (
          <div
            className="fexp-code-sizer"
            style={{
              paddingTop: offsetY,
              paddingBottom: Math.max(0, totalHeight - offsetY - (end - start) * CODE_LINE_HEIGHT_PX),
            }}
          >
            <div className="fexp-code-window">
              {rendered.map((html, index) => (
                <CodeRow key={start + index} lineNumber={start + index + 1} html={html} />
              ))}
            </div>
          </div>
        ) : (
          <div className="fexp-code-sizer" style={{ height: totalHeight }}>
            <div className="fexp-code-window" style={{ transform: `translateY(${offsetY}px)` }}>
              {rendered.map((html, index) => (
                <CodeRow key={start + index} lineNumber={start + index + 1} html={html} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CodeRow({ lineNumber, html }: { readonly lineNumber: number; readonly html: string }) {
  return (
    <div className="fexp-code-row">
      <span className="fexp-line-num" aria-hidden="true">{lineNumber}</span>
      <span
        className="fexp-line-code"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
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

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
