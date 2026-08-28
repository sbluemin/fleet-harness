import { getT } from "../../i18n/index.js";
import { fetchEntry } from "../api.js";
import { escapeHtml } from "../utils.js";
import { resolveActiveLocale } from "../../i18n/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EntryLinkPreview {
  destroy(): void;
}

interface PreviewData {
  readonly title: string;
  readonly meta: string;
  readonly excerpt: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SHOW_DELAY_MS = 220;
const EXCERPT_MAX_LENGTH = 180;
const CARD_WIDTH = 288;

function consoleT() {
  return getT(resolveActiveLocale());
}

/**
 * 본문 안 위키 링크(a[data-entry-id])에 호버/포커스 프리뷰 카드를 단다.
 * 프리뷰는 향상이다 — 조회 실패는 카드 안에서 조용히 알리고 링크 이동은 그대로 둔다.
 */
export function installEntryLinkPreview(
  container: HTMLElement,
  getTheaterId: () => string | null,
): EntryLinkPreview {
  const cache = new Map<string, PreviewData | null>();
  let card: HTMLElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let activeAnchor: HTMLAnchorElement | null = null;
  let requestEpoch = 0;

  function ensureCard(): HTMLElement {
    if (card?.isConnected) return card;
    card = document.createElement("div");
    card.className = "codex-link-preview";
    card.hidden = true;
    // 스크롤포트 좌표계에 정박한다 — 카드 위치가 스크롤을 따라간다.
    container.append(card);
    return card;
  }

  function hide(): void {
    if (showTimer !== null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    requestEpoch += 1;
    activeAnchor = null;
    if (card) card.hidden = true;
  }

  function position(anchor: HTMLElement, element: HTMLElement): void {
    const containerRect = container.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(anchorRect.left - containerRect.left, container.clientWidth - CARD_WIDTH - 8),
    );
    const top = anchorRect.bottom - containerRect.top + container.scrollTop + 8;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }

  function renderCard(data: PreviewData | null): string {
    const t = consoleT();
    if (data === null) {
      return `<span class="codex-link-preview-empty">${escapeHtml(t("codex.reading.previewUnavailable"))}</span>`;
    }
    return `
      <strong>${escapeHtml(data.title)}</strong>
      ${data.excerpt ? `<span class="codex-link-preview-excerpt">${escapeHtml(data.excerpt)}</span>` : ""}
      <span class="codex-link-preview-meta">${escapeHtml(data.meta)}</span>
    `;
  }

  async function loadPreview(id: string): Promise<PreviewData | null> {
    if (cache.has(id)) return cache.get(id) ?? null;
    try {
      const entry = await fetchEntry(getTheaterId(), id);
      const metaParts = [
        entry.frontmatter.status ?? "current",
        `v${entry.frontmatter.version}`,
        entry.frontmatter.tags.slice(0, 3).join(" · "),
      ].filter(Boolean);
      const data: PreviewData = {
        title: entry.frontmatter.title,
        meta: metaParts.join(" · "),
        excerpt: buildPreviewExcerpt(entry.body),
      };
      cache.set(id, data);
      return data;
    } catch {
      cache.set(id, null);
      return null;
    }
  }

  function show(anchor: HTMLAnchorElement, id: string): void {
    activeAnchor = anchor;
    const epoch = ++requestEpoch;
    void loadPreview(id).then((data) => {
      if (epoch !== requestEpoch || activeAnchor !== anchor || !anchor.isConnected) return;
      const element = ensureCard();
      element.innerHTML = renderCard(data);
      element.hidden = false;
      position(anchor, element);
    });
  }

  function anchorFrom(target: EventTarget | null): HTMLAnchorElement | null {
    if (!(target instanceof Element)) return null;
    const anchor = target.closest<HTMLAnchorElement>("a[data-entry-id]");
    if (!anchor || !container.contains(anchor)) return null;
    return anchor;
  }

  function handlePointerOver(event: PointerEvent): void {
    const anchor = anchorFrom(event.target);
    if (!anchor || anchor === activeAnchor) return;
    hide();
    const id = anchor.dataset.entryId ? decodeURIComponent(anchor.dataset.entryId) : "";
    if (!id) return;
    showTimer = setTimeout(() => {
      showTimer = null;
      show(anchor, id);
    }, SHOW_DELAY_MS);
    activeAnchor = anchor;
  }

  function handlePointerOut(event: PointerEvent): void {
    const anchor = anchorFrom(event.target);
    if (!anchor || anchor !== activeAnchor) return;
    const next = event.relatedTarget;
    if (next instanceof Node && (anchor.contains(next) || card?.contains(next))) return;
    hide();
  }

  function handleFocusIn(event: FocusEvent): void {
    const anchor = anchorFrom(event.target);
    if (!anchor) return;
    hide();
    const id = anchor.dataset.entryId ? decodeURIComponent(anchor.dataset.entryId) : "";
    if (id) show(anchor, id);
  }

  function handleFocusOut(event: FocusEvent): void {
    if (anchorFrom(event.target)) hide();
  }

  function handleScrollOrClick(): void {
    hide();
  }

  container.addEventListener("pointerover", handlePointerOver);
  container.addEventListener("pointerout", handlePointerOut);
  container.addEventListener("focusin", handleFocusIn);
  container.addEventListener("focusout", handleFocusOut);
  container.addEventListener("scroll", handleScrollOrClick, { passive: true });
  container.addEventListener("click", handleScrollOrClick);

  return {
    destroy(): void {
      hide();
      container.removeEventListener("pointerover", handlePointerOver);
      container.removeEventListener("pointerout", handlePointerOut);
      container.removeEventListener("focusin", handleFocusIn);
      container.removeEventListener("focusout", handleFocusOut);
      container.removeEventListener("scroll", handleScrollOrClick);
      container.removeEventListener("click", handleScrollOrClick);
      card?.remove();
      card = null;
    },
  };
}

// ─── Excerpt ──────────────────────────────────────────────────────────────────

// 첫 산문 문단만 뽑아 마크다운 장식을 걷어낸 한 줄 발췌를 만든다.
export function buildPreviewExcerpt(body: string): string {
  const withoutFrontmatter = body.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
  const blocks = withoutFrontmatter.replace(/\r\n/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("```") || trimmed.startsWith("<")) continue;
    const text = trimmed
      .replace(/\[\[wiki:([^\]]+)\]\]/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`>#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    return text.length > EXCERPT_MAX_LENGTH ? `${text.slice(0, EXCERPT_MAX_LENGTH - 1)}…` : text;
  }
  return "";
}
