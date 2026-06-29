import { useEffect, useMemo, useRef } from "react";
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

  return (
    <div className="fexp-md-wrap">
      {truncated && <div className="fexp-truncated-badge">File is too large — showing a partial preview</div>}
      <div
        ref={rootRef}
        className="markdown-body"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
