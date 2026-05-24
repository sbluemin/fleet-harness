import { renderMarkdown } from "../markdown/renderer";
import type { RawSourceState } from "../raw-state";
import { t } from "../i18n/t";

const BACK_ICON = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M15 18 9 12l6-6" />
  </svg>
`;

const SCROLL_ICON = `
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5 4h11a3 3 0 0 1 3 3v9.5a3.5 3.5 0 0 1-3.5 3.5H8a3 3 0 0 1-3-3V4z" />
    <path d="M9 9h6M9 13h6" />
  </svg>
`;

export function renderRawView(state: RawSourceState): string {
  const ref = state.ref ?? "";
  let body: string;
  if (state.loading) {
    body = `<p class="loading">${t("raw.loading")}</p>`;
  } else if (state.error) {
    body = `<p class="error-box">${t("raw.errorLoad")} — ${escapeHtml(state.error)}</p>`;
  } else if (!state.content) {
    body = `<p class="empty-state">${t("raw.emptyContent")}</p>`;
  } else {
    const rendered = renderMarkdown(state.content);
    body = `<div class="markdown-body">${rendered.html}</div>`;
  }
  return `
    <div class="raw-shell">
      <header class="raw-header">
        <a class="raw-back" href="/" data-action="navigate-home" aria-label="${t("raw.ariaBackToCodex")}">
          ${BACK_ICON}
          <span>Codex</span>
        </a>
        <div class="raw-meta">
          <span class="raw-glyph">${SCROLL_ICON}</span>
          <div class="raw-meta-text">
            <p class="eyebrow">Manifest · Raw Source</p>
            <h1 class="raw-title">${escapeHtml(ref)}</h1>
          </div>
        </div>
        <div class="raw-divider"></div>
      </header>
      <article class="raw-document">
        ${body}
      </article>
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
