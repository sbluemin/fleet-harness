import { entryPath } from "../router";
import type { BacklinkEntry } from "../api";

export function renderBacklinksPanel(backlinks: BacklinkEntry[], currentId: string | null): string {
  const content = currentId
    ? renderBacklinks(backlinks)
    : `<p class="empty-state">문서를 선택하면 이 자리에 백링크가 표시됩니다.</p>`;
  return `
    <aside class="backlinks-panel">
      <div>
        <h2>Constellation</h2>
        <p class="backlinks-subtitle">이 문서를 참조하는 항목</p>
      </div>
      ${content}
    </aside>
  `;
}

function renderBacklinks(backlinks: BacklinkEntry[]): string {
  if (backlinks.length === 0) {
    return `<p class="empty-state">아직 이 문서를 참조하는 다른 문서가 없습니다.</p>`;
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
