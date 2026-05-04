import type { WikiEntryFrontmatter, WikiIndexEntry } from "../api";
import { t } from "../i18n/t";
import { languageLocale } from "../i18n/store";

export function renderMetaChips(frontmatter: WikiEntryFrontmatter | WikiIndexEntry): string {
  const tags = frontmatter.tags.map((tag) => `<span class="chip chip-tag">${escapeHtml(tag)}</span>`).join("");
  return `
    <div class="meta-chips">
      ${tags}
      <span class="chip">${t("meta.updatedPrefix")} ${escapeHtml(formatDate(frontmatter.updated))}</span>
    </div>
  `;
}

export function renderTagChips(tags: string[]): string {
  return tags.map((tag) => `<span class="chip chip-muted">${escapeHtml(tag)}</span>`).join("");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(languageLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
