import type {
  BriefingHit,
  WikiEntryResponse,
  WikiIndexEntry,
} from "../api";
import { renderCopyContextActions } from "./copy-context-actions";
import { rawPath } from "../router";
import { escapeAttribute, escapeHtml } from "../utils/html";
import { formatAbsoluteDate, relativeTime } from "../utils/time";

const ARROW_ICON = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
`;

export function renderManifestPanel(
  entry: WikiEntryResponse | null,
  index: WikiIndexEntry[],
  hint: BriefingHit | null,
): string {
  if (!entry) return "";
  const { frontmatter } = entry;
  const absoluteCreated = formatAbsoluteDate(frontmatter.created);
  const relCreated = relativeTime(frontmatter.created);
  const absoluteUpdated = formatAbsoluteDate(frontmatter.updated);
  const relUpdated = relativeTime(frontmatter.updated);
  const actionsHtml = renderCopyContextActions(entry, index, hint);

  const tagsHtml = frontmatter.tags.length > 0
    ? `<div class="queue-card-chips">${frontmatter.tags.map((t_) => `<span class="chip chip-muted">${escapeHtml(t_)}</span>`).join("")}</div>`
    : `<span class="queue-dl-muted">None</span>`;

  const rawRefHtml = frontmatter.rawSourceRef
    ? `<a class="manifest-link queue-raw-link" href="${escapeAttribute(rawPath(frontmatter.rawSourceRef))}" data-raw-ref="${escapeAttribute(frontmatter.rawSourceRef)}">
        <span class="manifest-ref">${escapeHtml(frontmatter.rawSourceRef)}</span>
        <span class="manifest-arrow" aria-hidden="true">${ARROW_ICON}</span>
      </a>`
    : `<span class="queue-dl-muted">None</span>`;

  return `
    <details class="manifest-card" open>
      <summary class="manifest-summary" aria-label="Toggle document manifest">
        <span class="manifest-summary-copy">
          <span class="drydock-eyebrow">MANIFEST · CODEX</span>
          <span class="manifest-subtitle">Document Manifest</span>
        </span>
        <span class="manifest-summary-indicator" aria-hidden="true"></span>
      </summary>
      <dl class="queue-dl">
        <dt class="queue-dl-key">Created</dt>
        <dd class="queue-dl-value queue-dl-time">
          <time datetime="${escapeAttribute(frontmatter.created)}" title="${escapeAttribute(absoluteCreated)}">
            ${escapeHtml(absoluteCreated)}
            <span class="queue-dl-relative">(${escapeHtml(relCreated)})</span>
          </time>
        </dd>
        <dt class="queue-dl-key">Updated</dt>
        <dd class="queue-dl-value queue-dl-time">
          <time datetime="${escapeAttribute(frontmatter.updated)}" title="${escapeAttribute(absoluteUpdated)}">
            ${escapeHtml(absoluteUpdated)}
            <span class="queue-dl-relative">(${escapeHtml(relUpdated)})</span>
          </time>
        </dd>
        <dt class="queue-dl-key">Version</dt>
        <dd class="queue-dl-value queue-dl-mono">v${frontmatter.version}</dd>
        <dt class="queue-dl-key">Tags</dt>
        <dd class="queue-dl-value">${tagsHtml}</dd>
        <dt class="queue-dl-key">Source</dt>
        <dd class="queue-dl-value">${rawRefHtml}</dd>
      </dl>
      ${actionsHtml ? `<div class="manifest-actions">${actionsHtml}</div>` : ""}
    </details>
  `;
}
