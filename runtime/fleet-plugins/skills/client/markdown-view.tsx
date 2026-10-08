import { useCallback, useEffect, useMemo, useRef } from "react";

import { renderMarkdown } from "@fleet-console/markdown/core";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import "@fleet-console/markdown/styles.css";

import { getT, markdownCopyOptions } from "./i18n/index.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface MarkdownViewProps {
  readonly content: string;
  readonly language: ConsoleLocale | undefined;
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

export function MarkdownView({ content, language }: MarkdownViewProps) {
  const t = getT(language);
  const html = useMemo(() => {
    const rendered = renderMarkdown(content, markdownCopyOptions(t)).html;
    const doc = new DOMParser().parseFromString(rendered, "text/html");
    neutralizeUntrustedDom(doc.body);
    return doc.body.innerHTML;
  }, [content, t]);

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

  const copyStates = useRef(new Map<HTMLElement, { timer: number | null; seq: number }>());
  useEffect(() => {
    const held = copyStates.current;
    return () => {
      for (const entry of held.values()) if (entry.timer !== null) window.clearTimeout(entry.timer);
      held.clear();
    };
  }, []);

  const handleCopyClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
    if (!button) return;
    const code = button.closest("pre")?.getAttribute("data-code");
    // 빈 문자열은 복사할 코드다. 속성 자체가 없을 때만 대상이 아니다.
    if (code === null || code === undefined) return;
    const entry = copyStates.current.get(button) ?? { timer: null, seq: 0 };
    copyStates.current.set(button, entry);
    entry.seq += 1;
    const seq = entry.seq;
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = null;
    const settle = (state: "copied" | "failed") => {
      // 다시 눌렸거나 재렌더로 버튼이 빠졌다면 이 결과는 낡았다.
      if (entry.seq !== seq || !button.isConnected) return;
      button.textContent = t(state === "copied" ? "skills.markdown.copied" : "skills.markdown.copyFailed");
      entry.timer = window.setTimeout(() => {
        entry.timer = null;
        if (entry.seq !== seq || !button.isConnected) return;
        button.textContent = t("skills.markdown.copy");
      }, state === "copied" ? 1200 : 3000);
    };
    // 성공 글자는 writeText가 이행된 뒤에만 낸다. 클립보드가 없거나 던지거나 거절되면 모두 실패다.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard || typeof clipboard.writeText !== "function") { settle("failed"); return; }
    let write: Promise<void>;
    try { write = clipboard.writeText(code); } catch { settle("failed"); return; }
    void write.then(() => settle("copied"), () => settle("failed"));
  }, [t]);

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
