import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { FileReadResult } from "../server/types.js";
import { knownMtime } from "./entry-stats.js";
import { FileIcon } from "./file-icon.js";
import { formatByteSize, formatRelativeTime } from "./format.js";
import type { FileExplorerMessageKey } from "./i18n/index.js";
import { translateServerError } from "./i18n/index.js";
import { renderLine } from "./viewer/code.js";
import { cacheBustedImageSrc } from "./viewer/image.js";

/**
 * 훑어보기 — 포커스 행 옆에 잠깐 뜨는 첫 화면.
 *
 * 문서 열·칩·이력·주소 어느 것도 건드리지 않는다. "이게 그 파일인가"를 확인하는 데
 * 세션 흔적이 남지 않아야 하므로, 스토어를 거치지 않고 자기 상태로만 읽고 그린다.
 * 포커스도 가져가지 않는다 — 행이 포커스를 쥐고 있어야 ↑↓로 다음 파일을 훑을 수 있다.
 */

/** 훑어보기가 싣는 줄 수 — 한 화면의 "무슨 파일인가"에 충분하고, 그 이상은 문서로 연다. */
export const PEEK_LINES = 12;
const PEEK_GAP_PX = 6;
const PEEK_MARGIN_PX = 4;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

type PeekState =
  | { readonly kind: "loading" }
  | { readonly kind: "code"; readonly lines: readonly string[]; readonly lang: string; readonly lineCount?: number; readonly sizeBytes?: number; readonly mtimeMs: number }
  | { readonly kind: "image"; readonly src: string }
  | { readonly kind: "binary" }
  | { readonly kind: "error"; readonly message: string };

interface FilePeekProps {
  readonly theaterId: string;
  readonly relativePath: string;
  readonly name: string;
  /** 행의 위·아래 y — 뷰포트(boundary) 기준 px. 카드는 아래에 서고, 자리가 없으면 위로 뒤집힌다. */
  readonly anchorTop: number;
  readonly anchorBottom: number;
  readonly boundaryRef: RefObject<HTMLElement | null>;
  readonly t: Translate<FileExplorerMessageKey>;
}

/** 카드가 설 y — 아래 우선, 아래 공간이 모자라면 행 위로. */
export function resolvePeekTop(
  anchorTop: number,
  anchorBottom: number,
  cardHeight: number,
  boundaryHeight: number,
  gap: number = PEEK_GAP_PX,
  margin: number = PEEK_MARGIN_PX,
): number {
  const below = anchorBottom + gap;
  if (below + cardHeight + margin <= boundaryHeight) return below;
  const above = anchorTop - gap - cardHeight;
  if (above >= margin) return above;
  return Math.max(margin, Math.min(below, boundaryHeight - cardHeight - margin));
}

export function FilePeek({ theaterId, relativePath, name, anchorTop, anchorBottom, boundaryRef, t }: FilePeekProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PeekState>({ kind: "loading" });
  const [top, setTop] = useState<number | null>(null);

  useEffect(() => {
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      const src = cacheBustedImageSrc(
        `/plugins/file-explorer/files/image?theaterId=${encodeURIComponent(theaterId)}&path=${encodeURIComponent(relativePath)}`,
        knownMtime(theaterId, relativePath),
      );
      setState({ kind: "image", src });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading" });
    void (async () => {
      try {
        const res = await fetch("/plugins/file-explorer/files/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theaterId, relativePath, maxLines: PEEK_LINES }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const payload = await res.json() as { error?: string };
          throw new Error(payload.error ?? "read_failed");
        }
        const result = await res.json() as FileReadResult;
        if (controller.signal.aborted) return;
        if (result.binary) {
          setState({ kind: "binary" });
          return;
        }
        const lines = result.content.split("\n");
        if (lines.at(-1) === "") lines.pop();
        setState({
          kind: "code",
          lines,
          lang: result.lang,
          ...(result.lineCount !== undefined ? { lineCount: result.lineCount } : {}),
          sizeBytes: result.sizeBytes,
          mtimeMs: result.mtimeMs,
        });
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        const raw = error instanceof Error ? error.message : "read_failed";
        if (raw === "binary_file") setState({ kind: "binary" });
        else setState({ kind: "error", message: translateServerError(raw, t) });
      }
    })();
    return () => controller.abort();
  }, [name, relativePath, t, theaterId]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const boundary = boundaryRef.current;
    if (!card || !boundary) return;
    const place = () => {
      setTop(resolvePeekTop(anchorTop, anchorBottom, card.offsetHeight, boundary.clientHeight));
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(card);
    return () => observer.disconnect();
  }, [anchorBottom, anchorTop, boundaryRef, state]);

  const meta: string[] = [];
  if (state.kind === "code") {
    if (state.sizeBytes !== undefined) meta.push(formatByteSize(state.sizeBytes));
    if (state.lineCount !== undefined) meta.push(t("fileExplorer.viewer.lines", { count: state.lineCount }));
    meta.push(formatRelativeTime(state.mtimeMs, Date.now(), t));
  }

  return (
    <div
      ref={cardRef}
      className="fexp-peek"
      role="dialog"
      aria-label={t("fileExplorer.peek.aria", { name })}
      style={top === null ? { top: 0, visibility: "hidden" } : { top }}
    >
      <div className="fexp-peek-head">
        <span className="fexp-peek-name">
          <span className="fexp-tree-icon" aria-hidden="true"><FileIcon name={name} /></span>
          {name}
        </span>
        {meta.length > 0 && (
          <span className="fexp-peek-meta">
            {meta.map((part, index) => <span key={index} className="fexp-viewer-meta-part">{part}</span>)}
          </span>
        )}
      </div>
      {state.kind === "loading" && (
        <div className="fexp-skeleton is-peek" role="status" aria-label={t("fileExplorer.status.loading")}>
          {[120, 180, 90].map((width, index) => (
            <div key={index} className="fexp-skeleton-row"><span className="fexp-skeleton-bar" style={{ width }} /></div>
          ))}
        </div>
      )}
      {state.kind === "code" && (
        <pre className="fexp-peek-code">
          {state.lines.map((line, index) => (
            <span key={index} className="fexp-peek-line">
              <span className="fexp-peek-ln" aria-hidden="true">{index + 1}</span>
              <span
                className="fexp-peek-src"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: renderLine(line, state.lang) }}
              />
            </span>
          ))}
          {state.lines.length === 0 && <span className="fexp-peek-line"><span className="fexp-peek-ln" aria-hidden="true">1</span><span className="fexp-peek-src"> </span></span>}
        </pre>
      )}
      {state.kind === "code" && state.lineCount !== undefined && state.lineCount > state.lines.length && (
        <div className="fexp-peek-more">{t("fileExplorer.peek.more", { count: state.lineCount - state.lines.length })}</div>
      )}
      {state.kind === "image" && (
        <div className="fexp-peek-stage"><img className="fexp-peek-img" src={state.src} alt="" /></div>
      )}
      {state.kind === "binary" && <div className="fexp-peek-note">{t("fileExplorer.peek.binary")}</div>}
      {state.kind === "error" && <div className="fexp-peek-note is-error">{state.message}</div>}
      <div className="fexp-peek-keys" aria-hidden="true">
        <span><kbd>Enter</kbd> {t("fileExplorer.peek.open")}</span>
        <span><kbd>Space</kbd> {t("fileExplorer.peek.close")}</span>
        <span><kbd>↑↓</kbd> {t("fileExplorer.peek.next")}</span>
      </div>
    </div>
  );
}
