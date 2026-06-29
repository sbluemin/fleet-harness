import { useCallback, useEffect, useMemo, useRef } from "react";
import { renderMarkdown } from "@fleet-console/markdown/core";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import "@fleet-console/markdown/styles.css";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MarkdownViewerProps {
  readonly content: string;
  readonly truncated?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MarkdownViewer({ content, truncated }: MarkdownViewerProps) {
  const { html } = useMemo(() => renderMarkdown(content), [content]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (rootRef.current) installDiagramHydrator(rootRef.current);
  }, [html]);

  // 마크다운 내 상대/절대 경로 링크는 클릭 시 console SPA 탭을 가로채(/console/<path>로 이동)
  // 미리보기가 사라지므로 무력화한다(구 file-explorer 렌더러의 inert 링크 동작 보존).
  // 외부 링크(http/mailto)와 문서 내 앵커(#)는 정상 동작하도록 통과시킨다.
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (href && !/^(https?:|mailto:|#)/i.test(href)) {
      e.preventDefault();
    }
  }, []);

  return (
    <div className="fexp-md-wrap">
      {truncated && <div className="fexp-truncated-badge">File is too large — showing a partial preview</div>}
      <div
        ref={rootRef}
        className="markdown-body"
        onClick={handleClick}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
