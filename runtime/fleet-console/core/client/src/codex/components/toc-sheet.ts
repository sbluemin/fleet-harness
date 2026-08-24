import type { TocItem } from "@fleet-console/markdown/core";

import { getGlobalSettingsStoreState } from "../../global-settings-store.js";
import { getT } from "../../i18n/index.js";
import { resolveConsoleLanguage } from "../../whatsnew-i18n.js";
import { escapeAttribute, escapeHtml } from "../utils.js";

function resolveActiveLocale() {
  const preference = getGlobalSettingsStoreState().state?.language ?? "auto";
  const navigatorLanguage =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language.toLowerCase()
      : "";
  return resolveConsoleLanguage(preference, navigatorLanguage);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type TocCleanup = () => void;

// ─── Constants ────────────────────────────────────────────────────────────────

const ACTIVE_CLASS = "active";

// ─── Public API ───────────────────────────────────────────────────────────────

export function renderTocSheet(items: TocItem[]): string {
  if (items.length === 0) {
    const t = getT(resolveActiveLocale());
    return `<p class="toc-empty">${escapeHtml(t("codex.toc.noSections"))}</p>`;
  }
  return items
    .map(
      (item) =>
        `<a class="ti toc-level-${item.level}" href="#${escapeAttribute(item.id)}" data-toc-id="${escapeAttribute(item.id)}">${escapeHtml(item.text)}</a>`,
    )
    .join("");
}

export function installTocScrollSpy(
  article: HTMLElement,
  items: TocItem[],
  tocPanel: HTMLElement,
): TocCleanup {
  if (items.length === 0 || typeof IntersectionObserver === "undefined") return () => {};

  const links = [...tocPanel.querySelectorAll<HTMLAnchorElement>("[data-toc-id]")];
  const headingIds = new Set(items.map((item) => item.id));
  const headings = [
    ...article.querySelectorAll<HTMLElement>("h2[id], h3[id]"),
  ].filter((h) => headingIds.has(h.id));

  if (links.length === 0 || headings.length === 0) return () => {};

  const scrollRoot = article.closest<HTMLElement>(".codex-reading-sheet-read, .codex-doc-scroll");
  const visibleHeadings = new Set<string>();
  let lastEmittedId: string | null = null;

  // 접힌 아웃라인 스파인이 "지금 읽는 섹션"을 되비출 수 있도록 활성 전환을 이벤트로 알린다.
  const emitActive = (activeId: string | null) => {
    if (activeId === lastEmittedId) return;
    lastEmittedId = activeId;
    const text = activeId ? items.find((item) => item.id === activeId)?.text ?? "" : "";
    tocPanel.dispatchEvent(new CustomEvent("codex-toc-active", { bubbles: true, detail: { id: activeId, text } }));
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target instanceof HTMLElement ? entry.target.id : "";
        if (!id) continue;
        if (entry.isIntersecting) visibleHeadings.add(id);
        else visibleHeadings.delete(id);
      }
      const activeId =
        firstVisible(headings, visibleHeadings) ??
        lastAboveFold(headings, scrollRoot) ??
        headings[0]?.id ??
        null;
      setActiveLink(links, activeId);
      emitActive(activeId);
    },
    {
      root: scrollRoot,
      rootMargin: "-20% 0px -65% 0px",
      threshold: [0, 0.2, 0.6, 1],
    },
  );

  for (const h of headings) observer.observe(h);
  setActiveLink(links, headings[0]?.id ?? null);
  emitActive(headings[0]?.id ?? null);

  return () => {
    observer.disconnect();
    emitActive(null);
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function firstVisible(headings: HTMLElement[], visible: Set<string>): string | null {
  for (const h of headings) {
    if (visible.has(h.id)) return h.id;
  }
  return null;
}

function lastAboveFold(headings: HTMLElement[], scrollRoot: HTMLElement | null): string | null {
  const foldTop = scrollRoot ? scrollRoot.getBoundingClientRect().top : 0;
  let lastId: string | null = null;
  for (const h of headings) {
    if (h.getBoundingClientRect().top - foldTop <= 80) lastId = h.id;
    else break;
  }
  return lastId;
}

function setActiveLink(links: HTMLAnchorElement[], activeId: string | null): void {
  for (const link of links) {
    const isActive = Boolean(activeId && link.dataset.tocId === activeId);
    link.classList.toggle(ACTIVE_CLASS, isActive);
    if (isActive) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
