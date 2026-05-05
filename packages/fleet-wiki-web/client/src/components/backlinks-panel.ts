import { entryPath } from "../router";
import type { BacklinkEntry, OutgoingLinkEntry } from "../api";
import { t } from "../i18n/t";

export function renderBacklinksPanel(backlinks: BacklinkEntry[], outgoing: OutgoingLinkEntry[], currentId: string | null): string {
  const content = currentId
    ? `${renderBacklinks(backlinks)}${renderOutgoing(outgoing)}`
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

function renderOutgoing(outgoing: OutgoingLinkEntry[]): string {
  if (outgoing.length === 0) {
    return "";
  }
  return `
    <div class="outgoing-section">
      <p class="eyebrow">${t("backlinks.outgoingHeading")}</p>
      <ul class="backlink-list outgoing-list">
        ${outgoing.map((link) => `
          <li>
            <a href="${entryPath(link.id)}" data-entry-id="${escapeAttribute(link.id)}" title="${escapeAttribute(link.title)}">
              <span class="backlink-title">${escapeHtml(link.title)}</span>
              <span class="occurrences">${link.occurrences}</span>
            </a>
          </li>
        `).join("")}
      </ul>
    </div>
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
