import { renderMarkdown } from "../markdown/renderer";
import { conflictDetailPath } from "../router";
import type { ConflictDetailResponse, ConflictListItem } from "../api";
import { escapeHtml } from "../utils/html";

export function renderConflictsList(conflicts: ConflictListItem[]): string {
  return `
    <article class="document">
      <header class="document-header">
        <p class="eyebrow">MANIFEST · DRYDOCK</p>
        <h1>Conflicts</h1>
      </header>
      ${conflicts.length > 0 ? `
        <ul class="conflict-list">
          ${conflicts.map((item) => `
            <li>
              <a class="conflict-list-item" href="${conflictDetailPath(item.id)}">
                <span class="conflict-list-copy">
                  <strong>${escapeHtml(item.title)}</strong>
                  <small>${escapeHtml(item.id)}</small>
                </span>
                <span class="chip ${item.status === "open" ? "chip-coral" : "chip"}">${escapeHtml(item.status)}</span>
              </a>
            </li>
          `).join("")}
        </ul>
      ` : `<p class="empty-state">No conflicts to display.</p>`}
    </article>
  `;
}

export function renderConflictDetail(detail: ConflictDetailResponse): string {
  const sections = [
    renderConflictSection("Current", detail.current),
    renderConflictSection("Proposed", detail.proposed),
    renderConflictSection("Raw Source", detail.rawSource),
  ].filter(Boolean).join("");

  return `
    <article class="document">
      <header class="document-header">
        <p class="eyebrow">MANIFEST · DRYDOCK</p>
        <h1>${escapeHtml(detail.id)}</h1>
        <div class="meta-chips">
          <span class="chip chip-coral">${escapeHtml(String(detail.meta.status ?? "unknown"))}</span>
        </div>
      </header>
      <section class="conflict-meta-card">
        <pre>${escapeHtml(JSON.stringify(detail.meta, null, 2))}</pre>
      </section>
      ${sections || `<p class="empty-state">No conflicts to display.</p>`}
    </article>
  `;
}

function renderConflictSection(title: string, content: string | null): string {
  if (!content) return "";
  const rendered = renderMarkdown(content);
  return `
    <section class="conflict-section">
      <h2>${escapeHtml(title)}</h2>
      <div class="markdown-body">${rendered.html}</div>
    </section>
  `;
}
