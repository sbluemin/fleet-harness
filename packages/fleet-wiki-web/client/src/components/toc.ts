import type { TocItem } from "../markdown/renderer";

export function renderToc(items: TocItem[]): string {
  if (items.length === 0) return "";
  return `
    <nav class="toc-panel" aria-label="문서 목차">
      <h2>목차</h2>
      ${items.map((item) => `
        <a class="toc-level-${item.level}" href="#${escapeAttribute(item.id)}" data-toc-id="${escapeAttribute(item.id)}">
          ${escapeHtml(item.text)}
        </a>
      `).join("")}
    </nav>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
