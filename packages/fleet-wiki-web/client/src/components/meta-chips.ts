import type { WikiEntryFrontmatter, WikiIndexEntry } from "../api";

export function renderMetaChips(frontmatter: WikiEntryFrontmatter | WikiIndexEntry): string {
  const tags = frontmatter.tags.map((tag) => `<span class="chip chip-tag">${escapeHtml(tag)}</span>`).join("");
  return `
    <div class="meta-chips">
      ${tags}
      <span class="chip">Updated ${escapeHtml(formatDate(frontmatter.updated))}</span>
    </div>
  `;
}

export function renderTagChips(tags: string[]): string {
  return tags.map((tag) => `<span class="chip chip-muted">${escapeHtml(tag)}</span>`).join("");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
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
