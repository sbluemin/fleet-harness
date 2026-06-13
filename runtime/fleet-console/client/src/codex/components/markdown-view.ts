import { renderMetaChips, renderTagChips } from "./meta-chips";
import { renderRelatedList } from "./related-list";
import { renderMarkdown } from "../markdown/renderer";
import type { TocItem } from "../markdown/renderer";
import type { WikiEntryResponse, WikiIndexEntry } from "../api";
import { t } from "../i18n/t";
import { entryPath } from "../router";
import { escapeAttribute, escapeHtml } from "../utils/html";

export interface MarkdownViewRender {
  html: string;
  toc: TocItem[];
}

const ARROW_ICON = `
  <svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
`;

export function renderWelcome(entries: WikiIndexEntry[], cwd: string | null, hasWorkspace = true): string {
  const total = entries.length;
  const featured = entries.slice(0, 6);
  const firstEntry = entries[0] ?? null;
  return `
    <article class="document welcome">
      <header class="welcome-title">
        <p class="eyebrow">Fleet · Codex</p>
        <h1>The <em>Codex</em></h1>
      </header>
      <div class="welcome-divider"></div>
      <p class="lead">${t("markdown.welcomeLead")}</p>
      ${hasWorkspace ? "" : `<p class="error-box">No workspace is registered in this daemon. Re-run <code>fleet-wiki</code> in the target directory.</p>`}
      <div class="workspace-meta">
        <span class="chip chip-aurora">${t("markdown.entriesCount", { n: total })}</span>
        ${cwd ? `<span class="workspace-path">${escapeHtml(cwd)}</span>` : ""}
      </div>
      ${firstEntry ? `
        <a class="primary-link" href="${escapeAttribute(entryPath(firstEntry.id))}" data-entry-id="${escapeAttribute(firstEntry.id)}">
          <span>${t("markdown.openFirstPrefix")} ${escapeHtml(firstEntry.title)}</span>
          ${ARROW_ICON}
        </a>
      ` : `<p class="empty-state">${t("markdown.emptyWiki")}</p>`}
      ${featured.length > 0 ? `
        <div class="welcome-grid">
          ${featured.map((entry) => `
            <a class="welcome-card" href="${escapeAttribute(entryPath(entry.id))}" data-entry-id="${escapeAttribute(entry.id)}">
              <strong>${escapeHtml(entry.title)}</strong>
              <span class="welcome-card-tags">${renderTagChips(entry.tags.slice(0, 3))}</span>
            </a>
          `).join("")}
        </div>
      ` : ""}
    </article>
  `;
}

export function renderMarkdownView(
  entry: WikiEntryResponse,
  index: WikiIndexEntry[],
): MarkdownViewRender {
  const rendered = renderMarkdown(entry.body);
  return {
    toc: rendered.toc,
    html: `
    <article class="document">
      <header class="document-header">
        <p class="eyebrow">${t("markdown.wikiEntry")}</p>
        <h1>${escapeHtml(entry.frontmatter.title)}</h1>
        ${renderMetaChips(entry.frontmatter)}
      </header>
      <div class="markdown-body" id="markdown-body">
        ${rendered.html}
      </div>
      ${renderRelatedList(entry.frontmatter.id, entry.frontmatter.tags, index)}
    </article>
  `,
  };
}

export function renderLoading(): string {
  return `
    <article class="document">
      <p class="loading">${t("markdown.loadingEntry")}</p>
    </article>
  `;
}

export function renderError(message: string): string {
  return `
    <article class="document">
      <p class="error-box">${escapeHtml(message)}</p>
    </article>
  `;
}

