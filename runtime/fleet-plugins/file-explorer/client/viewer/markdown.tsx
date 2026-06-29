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
    const root = rootRef.current;
    if (!root) return;
    // file-explorer는 신뢰할 수 없는 임의 .md를 미리보기하므로 두 가지를 무력화한다:
    // 1) 상대/절대 경로 링크 href — 클릭(중간·우클릭 포함) 시 console SPA 탭을 가로채므로 제거.
    //    외부 링크(http/mailto)와 문서 내 앵커(#)는 보존한다.
    // 2) 이미지 src — 외부 이미지가 미리보기와 동시에 auto-fetch되어 추적(tracking pixel)·IP 노출에
    //    악용될 수 있으므로 제거한다.
    // 구 정규식 렌더러는 링크를 inert span으로, 이미지를 아예 렌더하지 않았다 — 그 안전 수준을 보존.
    const neutralizeUntrusted = () => {
      for (const anchor of root.querySelectorAll("a[href]")) {
        const href = anchor.getAttribute("href") ?? "";
        if (href && !/^(https?:|mailto:|#)/i.test(href)) {
          anchor.removeAttribute("href");
          anchor.setAttribute("role", "link");
          anchor.setAttribute("aria-disabled", "true");
        }
      }
      for (const img of root.querySelectorAll("img[src]")) {
        img.removeAttribute("src");
        img.setAttribute("aria-hidden", "true");
      }
    };
    installDiagramHydrator(root);
    neutralizeUntrusted();
    // Mermaid 하이드레이터가 비동기로 삽입하는 노드/속성(SPA href 등)도 즉시 무력화한다
    // (초기 1회 처리만으로는 누락되기 때문).
    const observer = new MutationObserver(neutralizeUntrusted);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "src"] });
    return () => observer.disconnect();
  }, [html]);

  // 공유 렌더러가 코드 블록에 주입하는 Copy 버튼(data-action="copy-code")을 처리한다.
  // codex는 자체 위임 핸들러를 두지만 file-explorer엔 없어 버튼이 무동작이었다 —
  // pre[data-code]의 원본 코드를 클립보드에 복사하고 잠시 "Copied" 피드백을 표시한다.
  const handleCopyClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
    if (!button) return;
    const code = button.closest("pre")?.getAttribute("data-code");
    if (!code) return;
    void navigator.clipboard?.writeText(code);
    const original = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = original;
    }, 1200);
  }, []);

  return (
    <div className="fexp-md-wrap">
      {truncated && <div className="fexp-truncated-badge">File is too large — showing a partial preview</div>}
      <div
        ref={rootRef}
        className="markdown-body"
        onClick={handleCopyClick}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
