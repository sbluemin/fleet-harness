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
  // file-explorer는 신뢰할 수 없는 임의 .md를 미리보기하므로, 렌더 HTML을 DOM에 mount하기 전에
  // 위험 요소를 무력화한다. 특히 이미지 src는 dangerouslySetInnerHTML로 삽입되는 즉시 브라우저가
  // fetch하므로(렌더 이후 실행되는 useEffect로는 이미 늦다) 반드시 mount 전에 제거해야 추적
  // (tracking pixel)·IP 노출을 막을 수 있다. 경로 링크 href도 함께 사전 제거한다.
  const html = useMemo(() => {
    const rendered = renderMarkdown(content).html;
    const doc = new DOMParser().parseFromString(rendered, "text/html");
    neutralizeUntrustedDom(doc.body);
    return doc.body.innerHTML;
  }, [content]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    installDiagramHydrator(root);
    // Mermaid 하이드레이터가 비동기로 삽입하는 노드/속성(SPA href 등)도 즉시 무력화한다
    // (mount 전 사전 처리만으로는 비동기 삽입분이 누락되기 때문).
    neutralizeUntrustedDom(root);
    const observer = new MutationObserver(() => neutralizeUntrustedDom(root));
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

// 신뢰 불가 미리보기에서 위험 요소를 무력화한다(구 정규식 렌더러의 안전 수준 보존):
// - 상대/절대 경로 링크 href 제거 — 클릭(중간·우클릭 'open link' 포함) 시 console SPA 탭
//   hijack을 차단한다. 외부 링크(http/mailto)와 문서 내 앵커(#)는 보존한다.
// - 이미지 src 제거 — 외부 이미지 auto-fetch로 인한 추적·IP 노출을 차단한다.
function neutralizeUntrustedDom(root: ParentNode): void {
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
}
