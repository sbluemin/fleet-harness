import { useCallback, useEffect, useMemo, useRef } from "react";

import { renderMarkdown } from "@fleet-console/markdown/core";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import "@fleet-console/markdown/styles.css";

import { getT, markdownCopyOptions } from "./i18n/index.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface MarkdownViewProps {
  readonly content: string;
  readonly language: ConsoleLocale | undefined;
  readonly currentPath?: string | undefined;
  readonly onOpenRelativeFile?: ((path: string) => void) | undefined;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function resolveRelativeMarkdownPath(href: string, currentPath: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(trimmed) || trimmed.includes("\\")) return null;
  const encodedPath = trimmed.split(/[?#]/, 1)[0] ?? "";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (!decodedPath || decodedPath.startsWith("/") || decodedPath.includes("\\")) return null;

  const baseParts = currentPath.includes("/")
    ? currentPath.slice(0, currentPath.lastIndexOf("/")).split("/").filter(Boolean)
    : [];
  for (const part of decodedPath.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (baseParts.length === 0) return null;
      baseParts.pop();
      continue;
    }
    if (part.startsWith(".")) return null;
    baseParts.push(part);
  }
  return baseParts.length > 0 ? baseParts.join("/") : null;
}

function neutralizeUntrustedDom(root: ParentNode, allowRelativeFiles: boolean, currentPath: string): void {
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    const relativePath = resolveRelativeMarkdownPath(href, currentPath);
    if (relativePath && allowRelativeFiles) {
      anchor.setAttribute("href", "#");
      anchor.setAttribute("data-skill-file", relativePath);
      continue;
    }
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

export function MarkdownView({ content, language, currentPath = "SKILL.md", onOpenRelativeFile }: MarkdownViewProps) {
  const t = getT(language);
  const html = useMemo(() => {
    const rendered = renderMarkdown(content, markdownCopyOptions(t)).html;
    const doc = new DOMParser().parseFromString(rendered, "text/html");
    neutralizeUntrustedDom(doc.body, onOpenRelativeFile !== undefined, currentPath);
    return doc.body.innerHTML;
  }, [content, currentPath, onOpenRelativeFile, t]);

  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    neutralizeUntrustedDom(root, onOpenRelativeFile !== undefined, currentPath);
    const observer = new MutationObserver(() => neutralizeUntrustedDom(root, onOpenRelativeFile !== undefined, currentPath));
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "src", "srcset"],
    });
    return () => observer.disconnect();
  }, [currentPath, html, onOpenRelativeFile]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const relativeAnchor = (e.target as HTMLElement).closest<HTMLElement>("[data-skill-file]");
    if (relativeAnchor && onOpenRelativeFile) {
      e.preventDefault();
      const relativePath = relativeAnchor.getAttribute("data-skill-file");
      if (relativePath) onOpenRelativeFile(relativePath);
      return;
    }
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
    if (!button) return;
    const code = button.closest("pre")?.getAttribute("data-code");
    if (!code) return;
    void navigator.clipboard?.writeText(code);
    const original = button.textContent;
    button.textContent = t("skills.markdown.copied");
    window.setTimeout(() => { button.textContent = original; }, 1200);
  }, [onOpenRelativeFile, t]);

  return (
    <div
      ref={rootRef}
      className="markdown-body"
      onClick={handleClick}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
