import { rawPath } from "../router";
import type { WikiEntryResponse } from "../api";
import { formatAbsoluteDate, relativeTime } from "../utils/time";

const ARROW_ICON = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
`;

export function renderManifestPanel(entry: WikiEntryResponse | null): string {
  if (!entry) return "";
  const { frontmatter } = entry;
  const absoluteCreated = formatAbsoluteDate(frontmatter.created);
  const relCreated = relativeTime(frontmatter.created);
  const absoluteUpdated = formatAbsoluteDate(frontmatter.updated);
  const relUpdated = relativeTime(frontmatter.updated);

  const tagsHtml = frontmatter.tags.length > 0
    ? `<div class="queue-card-chips">${frontmatter.tags.map((t) => `<span class="chip chip-muted">${escapeHtml(t)}</span>`).join("")}</div>`
    : `<span class="queue-dl-muted">없음</span>`;

  const rawRefHtml = frontmatter.rawSourceRef
    ? `<a class="manifest-link queue-raw-link" href="${escapeAttribute(rawPath(frontmatter.rawSourceRef))}" data-raw-ref="${escapeAttribute(frontmatter.rawSourceRef)}">
        <span class="manifest-ref">${escapeHtml(frontmatter.rawSourceRef)}</span>
        <span class="manifest-arrow" aria-hidden="true">${ARROW_ICON}</span>
      </a>`
    : `<span class="queue-dl-muted">없음</span>`;

  return `
    <aside class="manifest-card">
      <div class="manifest-header">
        <div class="manifest-titles">
          <p class="drydock-eyebrow">MANIFEST · CODEX</p>
          <p class="manifest-subtitle">문서 매니페스트</p>
        </div>
      </div>
      <dl class="queue-dl">
        <dt class="queue-dl-key">생성</dt>
        <dd class="queue-dl-value queue-dl-time">
          <time datetime="${escapeAttribute(frontmatter.created)}" title="${escapeAttribute(absoluteCreated)}">
            ${escapeHtml(absoluteCreated)}
            <span class="queue-dl-relative">(${escapeHtml(relCreated)})</span>
          </time>
        </dd>
        <dt class="queue-dl-key">갱신</dt>
        <dd class="queue-dl-value queue-dl-time">
          <time datetime="${escapeAttribute(frontmatter.updated)}" title="${escapeAttribute(absoluteUpdated)}">
            ${escapeHtml(absoluteUpdated)}
            <span class="queue-dl-relative">(${escapeHtml(relUpdated)})</span>
          </time>
        </dd>
        <dt class="queue-dl-key">버전</dt>
        <dd class="queue-dl-value queue-dl-mono">v${frontmatter.version}</dd>
        <dt class="queue-dl-key">태그</dt>
        <dd class="queue-dl-value">${tagsHtml}</dd>
        <dt class="queue-dl-key">원본</dt>
        <dd class="queue-dl-value">${rawRefHtml}</dd>
      </dl>
    </aside>
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
