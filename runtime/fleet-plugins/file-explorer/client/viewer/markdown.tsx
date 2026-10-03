import { useCallback, useEffect, useMemo, useRef } from "react";
import { renderMarkdown, type RenderMarkdownOptions } from "@fleet-console/markdown/core";
import { bindMarkdownLinkActivation, type MarkdownLinkTarget } from "@fleet-console/markdown/link-activation";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import type { ClientNavigateCapability } from "@fleet-console/sdk/navigation";
import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import "@fleet-console/markdown/styles.css";

import { diagramHydratorLabels, getT, markdownCopyOptions, type FileExplorerMessageKey } from "../i18n/index.js";
import { positiveCoordinate } from "../file-navigation.js";
import { showFileNavigationError } from "../view-store.js";
import { buildFileExplorerImageSrc, isAllowedExternalMarkdownImageSrc, isSupportedMarkdownImagePath, resolveMarkdownFileRef } from "./markdown-links.js";

const WIKI_LINK_PREFIX = "#file-explorer-wiki:";
export const resolveFileExplorerWikiLink = (id: string): string => WIKI_LINK_PREFIX + encodeURIComponent(id);

interface MarkdownViewerProps {
  readonly content: string;
  readonly navigate: ClientNavigateCapability;
  readonly resolveWikiLink: RenderMarkdownOptions["resolveWikiLink"];
  readonly relativePath: string;
  readonly theaterId: string | null;
  readonly truncated?: boolean;
  readonly language: ConsoleLocale | undefined;
  readonly target?: { readonly anchor?: string; readonly requestId: string; readonly relativePath: string };
}

interface NeutralizeOptions {
  readonly allowLocalImageMarkers: boolean;
  readonly currentRelativePath: string;
  readonly theaterId: string | null;
  readonly t: Translate<FileExplorerMessageKey>;
}

export function MarkdownViewer({ content, navigate, resolveWikiLink, relativePath, theaterId, truncated, language, target }: MarkdownViewerProps) {
  const t = getT(language);
  const html = useMemo(() => {
    const rendered = renderMarkdown(content, {
      ...markdownCopyOptions(t),
      resolveWikiLink,
      resolveLink: (href): MarkdownLinkTarget | null => {
        if (href.startsWith(WIKI_LINK_PREFIX)) {
          try { return { kind: "wiki", data: { entryId: decodeURIComponent(href.slice(WIKI_LINK_PREFIX.length)) } }; }
          catch { return null; }
        }
        const ref = resolveMarkdownFileRef(href, relativePath);
        return ref ? { kind: "file", data: {
          path: ref.path,
          ...(ref.line ? { line: String(ref.line) } : {}),
          ...(ref.column ? { column: String(ref.column) } : {}),
          ...(ref.anchor ? { anchor: ref.anchor } : {}),
        } } : null;
      },
    }).html;
    const doc = new DOMParser().parseFromString(rendered, "text/html");
    neutralizeUntrustedDom(doc.body, { allowLocalImageMarkers: false, currentRelativePath: relativePath, theaterId, t });
    return doc.body.innerHTML;
  }, [content, relativePath, resolveWikiLink, theaterId, t]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    installDiagramHydrator(root, diagramHydratorLabels(t));
    const neutralize = () => neutralizeUntrustedDom(root, { allowLocalImageMarkers: true, currentRelativePath: relativePath, theaterId, t });
    neutralize();
    const observer = new MutationObserver(neutralize);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "src", "srcset"] });
    return () => observer.disconnect();
  }, [html, relativePath, theaterId, t]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !theaterId) return;
    return bindMarkdownLinkActivation(root, (kind, data) => {
      const request = kind === "wiki"
        ? navigate.openWikiEntry({ theaterId, entryId: data.entryId ?? "" })
        : kind === "file" && data.path
          ? navigate.openFile({
            theaterId, path: data.path + (data.anchor ? `#${encodeURIComponent(data.anchor)}` : ""),
            pathKind: "theater-relative", line: positiveCoordinate(data.line), column: positiveCoordinate(data.column), source: "files",
          }) : null;
      void request?.then((result) => { if (!result.ok) showFileNavigationError(result.reason); })
        .catch(() => showFileNavigationError("not_found"));
    });
  }, [navigate, theaterId, html]);

  useEffect(() => {
    if (!target?.anchor || target.relativePath !== relativePath) return;
    rootRef.current?.querySelector<HTMLElement>(`#${CSS.escape(target.anchor)}`)?.scrollIntoView({ block: "start" });
  }, [html, relativePath, target?.anchor, target?.relativePath, target?.requestId]);

  const handleCopyClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
    if (!button) return;
    const code = button.closest("pre")?.getAttribute("data-code");
    if (!code) return;
    void navigator.clipboard?.writeText(code);
    const original = button.textContent;
    button.textContent = t("fileExplorer.markdown.copied");
    window.setTimeout(() => { button.textContent = original; }, 1200);
  }, [t]);

  return (
    <div className="fexp-md-wrap">
      {truncated && <div className="fexp-truncated-badge">{t("fileExplorer.viewer.truncated")}</div>}
      <div ref={rootRef} className="markdown-body" onClick={handleCopyClick}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function neutralizeUntrustedDom(root: ParentNode, options: NeutralizeOptions): void {
  for (const anchor of root.querySelectorAll("a[href]")) {
    if (anchor.hasAttribute("data-md-link-kind")) continue;
    const href = anchor.getAttribute("href") ?? "";
    if (href && !/^(https?:|mailto:|#)/i.test(href)) {
      anchor.removeAttribute("href");
      anchor.setAttribute("role", "link");
      anchor.setAttribute("aria-disabled", "true");
    }
  }
  for (const element of root.querySelectorAll("img[src], img[srcset], source[src], source[srcset]")) {
    const src = element.getAttribute("src") ?? "";
    const localImagePath = element.getAttribute("data-fexp-local-image-path");
    if (element.tagName === "IMG" && options.allowLocalImageMarkers && options.theaterId && localImagePath && src === buildFileExplorerImageSrc(options.theaterId, localImagePath)) {
      element.removeAttribute("srcset");
      continue;
    }
    element.removeAttribute("data-fexp-local-image-path");
    if (element.tagName === "IMG" && isAllowedExternalMarkdownImageSrc(src)) {
      element.removeAttribute("srcset");
      element.removeAttribute("aria-hidden");
      continue;
    }
    const local = resolveMarkdownFileRef(src, options.currentRelativePath);
    element.removeAttribute("srcset");
    if (element.tagName === "IMG" && options.theaterId && local && isSupportedMarkdownImagePath(local.path)) {
      element.setAttribute("src", buildFileExplorerImageSrc(options.theaterId, local.path));
      element.setAttribute("data-fexp-local-image-path", local.path);
      element.removeAttribute("aria-hidden");
      continue;
    }
    element.removeAttribute("src");
    if (element.tagName === "IMG") replaceBlockedImage(element, options.t);
  }
}

function replaceBlockedImage(element: Element, t: Translate<FileExplorerMessageKey>): void {
  const alt = element.getAttribute("alt")?.trim();
  const placeholder = element.ownerDocument.createElement("span");
  placeholder.className = "fexp-md-blocked-image";
  placeholder.textContent = alt ? t("fileExplorer.viewer.imageBlockedNamed", { alt }) : t("fileExplorer.viewer.imageBlocked");
  element.replaceWith(placeholder);
}
