import type { TocItem } from "../markdown/renderer";
import { t } from "../i18n/t";

export function renderToc(items: TocItem[]): string {
  if (items.length === 0) return "";
  return `
    <nav class="toc-panel" aria-label="${t("toc.ariaLabel")}">
      <h2>${t("toc.heading")}</h2>
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
