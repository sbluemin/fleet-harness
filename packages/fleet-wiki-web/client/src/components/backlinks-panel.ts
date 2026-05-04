import { entryPath } from "../router";
import type { BacklinkEntry } from "../api";
import { t } from "../i18n/t";

export function renderBacklinksPanel(backlinks: BacklinkEntry[], currentId: string | null): string {
  const content = currentId
    ? renderBacklinks(backlinks)
    : `<p class="empty-state">${t("backlinks.emptyNoEntry")}</p>`;
  return `
    <aside class="backlinks-panel">
      <div>
        <h2>Constellation</h2>
        <p class="backlinks-subtitle">${t("backlinks.subtitle")}</p>
      </div>
      ${content}
    </aside>
  `;
}

function renderBacklinks(backlinks: BacklinkEntry[]): string {
  if (backlinks.length === 0) {
    return `<p class="empty-state">${t("backlinks.emptyNone")}</p>`;
  }
  return `
    <ul class="backlink-list">
      ${backlinks.map((backlink) => `
        <li>
          <a href="${entryPath(backlink.id)}" data-entry-id="${escapeAttribute(backlink.id)}" title="${escapeAttribute(backlink.title)}">
            <span class="backlink-title">${escapeHtml(backlink.title)}</span>
            <span class="occurrences">${backlink.occurrences}</span>
          </a>
        </li>
      `).join("")}
    </ul>
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
