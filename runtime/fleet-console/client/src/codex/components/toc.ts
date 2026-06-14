import type { TocItem } from "../markdown/renderer";
import { escapeAttribute, escapeHtml } from "../utils/html";

export function renderToc(items: TocItem[]): string {
  if (items.length === 0) return "";
  return `
    <nav class="toc-panel" aria-label="Table of contents">
      <h2>Contents</h2>
      ${items.map((item) => `
        <a class="toc-level-${item.level}" href="#${escapeAttribute(item.id)}" data-toc-id="${escapeAttribute(item.id)}">
          ${escapeHtml(item.text)}
        </a>
      `).join("")}
    </nav>
  `;
}
