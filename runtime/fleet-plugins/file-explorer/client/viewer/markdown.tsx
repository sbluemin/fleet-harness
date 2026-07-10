import { useCallback, useEffect, useMemo, useRef } from "react";
import { renderMarkdown } from "@fleet-console/markdown/core";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import "@fleet-console/markdown/styles.css";

import {
  buildFileExplorerImageSrc,
  isAllowedExternalMarkdownImageSrc,
  isSupportedMarkdownImagePath,
  resolveMarkdownFileRef,
} from "./markdown-links.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MarkdownViewerProps {
  readonly content: string;
  readonly onOpenPath: (relativePath: string) => void;
  readonly relativePath: string;
  readonly theaterId: string | null;
  readonly contextRelPath: string | null;
  readonly truncated?: boolean;
}

interface NeutralizeOptions {
  readonly allowLocalImageMarkers: boolean;
  readonly currentRelativePath: string;
  readonly theaterId: string | null;
  readonly contextRelPath: string | null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MarkdownViewer({ content, onOpenPath, relativePath, theaterId, contextRelPath, truncated }: MarkdownViewerProps) {
  // file-explorer는 신뢰할 수 없는 임의 .md를 미리보기하므로, 렌더 HTML을 DOM에 mount하기 전에
  // 위험 요소를 무력화한다. 로컬 이미지/링크는 안전한 console 내부 경로로만 되살리고, 외부
  // 이미지는 mount 전에 제거해야 추적(tracking pixel)·IP 노출을 막을 수 있다.
  const html = useMemo(() => {
    const rendered = renderMarkdown(content).html;
    const doc = new DOMParser().parseFromString(rendered, "text/html");
    neutralizeUntrustedDom(doc.body, { allowLocalImageMarkers: false, currentRelativePath: relativePath, theaterId, contextRelPath });
    return doc.body.innerHTML;
  }, [content, relativePath, theaterId, contextRelPath]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    installDiagramHydrator(root);
    // Mermaid 하이드레이터가 비동기로 삽입하는 노드/속성(SPA href 등)도 즉시 무력화한다
    // (mount 전 사전 처리만으로는 비동기 삽입분이 누락되기 때문).
    neutralizeUntrustedDom(root, { allowLocalImageMarkers: true, currentRelativePath: relativePath, theaterId, contextRelPath });
    const observer = new MutationObserver(() => neutralizeUntrustedDom(root, { allowLocalImageMarkers: true, currentRelativePath: relativePath, theaterId, contextRelPath }));
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "src", "srcset"] });
    return () => observer.disconnect();
  }, [html, relativePath, theaterId, contextRelPath]);

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
  const handleLinkClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const localLink = target.closest<HTMLElement>("[data-fexp-open-path]");
    if (!localLink) return;
    const nextPath = localLink.dataset.fexpOpenPath;
    if (!nextPath) return;
    e.preventDefault();
    onOpenPath(nextPath);
  }, [onOpenPath]);
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target as HTMLElement;
    const localLink = target.closest<HTMLElement>("[data-fexp-open-path]");
    if (!localLink) return;
    const nextPath = localLink.dataset.fexpOpenPath;
    if (!nextPath) return;
    e.preventDefault();
    onOpenPath(nextPath);
  }, [onOpenPath]);
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    handleCopyClick(e);
    handleLinkClick(e);
  }, [handleCopyClick, handleLinkClick]);

  return (
    <div className="fexp-md-wrap">
      {truncated && <div className="fexp-truncated-badge">File is too large — showing a partial preview</div>}
      <div
        ref={rootRef}
        className="markdown-body"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// 신뢰 불가 미리보기에서 위험 요소를 무력화한다(구 정규식 렌더러의 안전 수준 보존):
// - 로컬 상대 링크는 href 대신 data-fexp-open-path로 바꿔 SPA URL hijack을 차단한다.
// - 로컬 이미지는 same-origin 이미지 라우트로 되살리고, allowlist 밖 외부 이미지는 auto-fetch를 차단한다.
function neutralizeUntrustedDom(root: ParentNode, options: NeutralizeOptions): void {
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    const localPath = resolveMarkdownFileRef(href, options.currentRelativePath);
    if (localPath) {
      anchor.removeAttribute("href");
      anchor.setAttribute("role", "link");
      anchor.setAttribute("tabindex", "0");
      anchor.setAttribute("data-fexp-open-path", localPath);
      anchor.removeAttribute("aria-disabled");
    } else if (href && !/^(https?:|mailto:|#)/i.test(href)) {
      anchor.removeAttribute("href");
      anchor.setAttribute("role", "link");
      anchor.setAttribute("aria-disabled", "true");
    }
  }

  for (const element of root.querySelectorAll("img[src], img[srcset], source[src], source[srcset]")) {
    const src = element.getAttribute("src") ?? "";
    const localImagePath = element.getAttribute("data-fexp-local-image-path");
    if (
      element.tagName === "IMG"
      && options.allowLocalImageMarkers
      && options.theaterId
      && localImagePath
      && src === buildFileExplorerImageSrc(options.theaterId, localImagePath, options.contextRelPath)
    ) {
      element.removeAttribute("srcset");
      continue;
    }
    element.removeAttribute("data-fexp-local-image-path");
    if (element.tagName === "IMG" && isAllowedExternalMarkdownImageSrc(src)) {
      element.removeAttribute("srcset");
      element.removeAttribute("aria-hidden");
      continue;
    }
    const localPath = resolveMarkdownFileRef(src, options.currentRelativePath);
    element.removeAttribute("srcset");
    if (element.tagName === "IMG" && options.theaterId && localPath && isSupportedMarkdownImagePath(localPath)) {
      element.setAttribute("src", buildFileExplorerImageSrc(options.theaterId, localPath, options.contextRelPath));
      element.setAttribute("data-fexp-local-image-path", localPath);
      element.removeAttribute("aria-hidden");
      continue;
    }
    element.removeAttribute("src");
    if (element.tagName === "IMG") replaceBlockedImage(element);
  }
}

function replaceBlockedImage(element: Element): void {
  const alt = element.getAttribute("alt")?.trim();
  const placeholder = element.ownerDocument.createElement("span");
  placeholder.className = "fexp-md-blocked-image";
  placeholder.textContent = alt ? `Image blocked: ${alt}` : "Image blocked";
  element.replaceWith(placeholder);
}
