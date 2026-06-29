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
    const root = rootRef.current;
    if (!root) return;
    // 상대/절대 경로 링크는 href를 제거해 완전히 inert화한다 — onClick preventDefault만으로는
    // 중간클릭·우클릭 'open link'가 남은 href로 console SPA 탭을 가로채기 때문(구 inert span 동작 복원).
    // 외부 링크(http/mailto)와 문서 내 앵커(#)는 보존한다.
    const stripPathHrefs = () => {
      for (const anchor of root.querySelectorAll("a[href]")) {
        const href = anchor.getAttribute("href") ?? "";
        if (href && !/^(https?:|mailto:|#)/i.test(href)) {
          anchor.removeAttribute("href");
          anchor.setAttribute("role", "link");
          anchor.setAttribute("aria-disabled", "true");
        }
      }
    };
    installDiagramHydrator(root);
    stripPathHrefs();
    // Mermaid 하이드레이터는 비동기로 SVG를 렌더하며 same-origin SPA href를 재삽입하므로,
    // DOM 변이를 관찰해 뒤늦게 들어온 경로 링크 href도 제거한다(초기 strip만으로는 누락).
    const observer = new MutationObserver(stripPathHrefs);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
    return () => observer.disconnect();
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
