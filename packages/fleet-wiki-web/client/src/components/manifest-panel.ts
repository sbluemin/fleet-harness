import { rawPath } from "../router";
import type { WikiEntryResponse } from "../api";

const ARROW_ICON = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
`;

const SCROLL_ICON = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5 4h11a3 3 0 0 1 3 3v9.5a3.5 3.5 0 0 1-3.5 3.5H8a3 3 0 0 1-3-3V4z" />
    <path d="M9 9h6M9 13h6" />
  </svg>
`;

export function renderManifestPanel(entry: WikiEntryResponse | null): string {
  if (!entry || !entry.frontmatter.rawSourceRef) return "";
  const ref = entry.frontmatter.rawSourceRef;
  const safeRef = escapeAttribute(ref);
  const url = rawPath(ref);
  return `
    <aside class="manifest-card">
      <div class="manifest-header">
        <span class="manifest-glyph">${SCROLL_ICON}</span>
        <div class="manifest-titles">
          <h2>Manifest</h2>
          <p class="manifest-subtitle">원본 출처</p>
        </div>
      </div>
      <a class="manifest-link" href="${escapeAttribute(url)}" data-raw-ref="${safeRef}" title="${safeRef} — 원본 출처 열기">
        <span class="manifest-ref">${escapeHtml(ref)}</span>
        <span class="manifest-arrow" aria-hidden="true">${ARROW_ICON}</span>
      </a>
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
