import { useCallback, useEffect, useMemo, useRef } from "react";

import { renderMarkdown } from "@fleet-console/markdown/core";
import "@fleet-console/markdown/styles.css";

// ─── types ───────────────────────────────────────────────────────────────────

interface MarkdownViewProps {
  readonly content: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function neutralizeUntrustedDom(root: ParentNode): void {
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    if (href && !/^(https?:|mailto:|#)/i.test(href)) {
      anchor.removeAttribute("href");
      anchor.setAttribute("role", "link");
      anchor.setAttribute("aria-disabled", "true");
    }
  }
  for (const el of root.querySelectorAll("img[src], img[srcset], source[src], source[srcset]")) {
    el.removeAttribute("src");
    el.removeAttribute("srcset");
    if (el.tagName === "IMG") el.setAttribute("aria-hidden", "true");
  }
}

// ─── MarkdownView ─────────────────────────────────────────────────────────────

export function MarkdownView({ content }: MarkdownViewProps) {
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
    neutralizeUntrustedDom(root);
    const observer = new MutationObserver(() => neutralizeUntrustedDom(root));
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "src", "srcset"],
    });
    return () => observer.disconnect();
  }, [html]);

  const handleCopyClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
    if (!button) return;
    const code = button.closest("pre")?.getAttribute("data-code");
    if (!code) return;
    void navigator.clipboard?.writeText(code);
    const original = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = original; }, 1200);
  }, []);

  return (
    <div
      ref={rootRef}
      className="markdown-body"
      onClick={handleCopyClick}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
