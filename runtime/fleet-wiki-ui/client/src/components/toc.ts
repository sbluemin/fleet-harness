import type { TocItem } from "../markdown/renderer";
import { t } from "../i18n/t";
import { escapeAttribute, escapeHtml } from "../utils/html";

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
