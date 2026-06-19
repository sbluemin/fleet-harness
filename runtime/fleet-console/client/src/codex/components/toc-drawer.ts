import type { TocItem } from "../markdown/renderer";
import { escapeAttribute, escapeHtml } from "../utils/html";

const CLOSE_ICON = `
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6 6 18 18M18 6 6 18" />
  </svg>
`;

const LIST_ICON = `
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 6h12M8 12h12M8 18h12" />
    <path d="M4 6h.01M4 12h.01M4 18h.01" />
  </svg>
`;

export function renderTocDrawerTrigger(items: TocItem[]): string {
  if (items.length === 0) return "";
  return `
    <button class="toc-drawer-trigger" type="button" data-action="open-toc-drawer" aria-haspopup="dialog" aria-controls="toc-drawer">
      ${LIST_ICON}
      <span>Contents</span>
    </button>
  `;
}

export function renderTocDrawer(items: TocItem[]): string {
  if (items.length === 0) return "";
  return `
    <div class="toc-drawer" id="toc-drawer" role="dialog" aria-modal="true" aria-labelledby="toc-drawer-title" hidden>
      <button class="toc-drawer-backdrop" type="button" data-action="close-toc-drawer" aria-label="Close contents"></button>
      <section class="toc-drawer-panel">
        <header class="toc-drawer-header">
          <div>
            <p class="drydock-eyebrow">Reading Position</p>
            <h2 id="toc-drawer-title">Contents</h2>
          </div>
          <button class="icon-button" type="button" data-action="close-toc-drawer" aria-label="Close contents">${CLOSE_ICON}</button>
        </header>
        <nav class="toc-drawer-nav" aria-label="Document contents">
          ${items.map((item) => `
            <a class="toc-drawer-link toc-level-${item.level}" href="#${escapeAttribute(item.id)}" data-toc-id="${escapeAttribute(item.id)}">
              ${escapeHtml(item.text)}
            </a>
          `).join("")}
        </nav>
      </section>
    </div>
  `;
}
