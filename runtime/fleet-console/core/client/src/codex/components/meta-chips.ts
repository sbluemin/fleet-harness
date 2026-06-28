import type { EntryFrontmatter, SearchEntry } from "../api";
import { escapeAttribute, escapeHtml } from "../utils/html";

export interface EntryStatusBadge {
  label: string;
  tone: "neutral" | "stale" | "deprecated";
  title: string;
}

export function renderMetaChips(frontmatter: EntryFrontmatter | SearchEntry): string {
  const tags = frontmatter.tags.map((tag) => `<span class="chip chip-tag">${escapeHtml(tag)}</span>`).join("");
  const badge = renderStatusBadge(frontmatter);
  return `
    <div class="meta-chips">
      ${tags}
      ${badge}
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
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function renderStatusBadge(frontmatter: EntryFrontmatter | SearchEntry): string {
  const badge = getEntryStatusBadge(frontmatter);
  if (!badge) return "";
  return `<span class="chip ${badge.tone === "deprecated" ? "chip-coral" : badge.tone === "stale" ? "chip-stale" : ""}" title="${escapeAttribute(badge.title)}">${escapeHtml(badge.label)}</span>`;
}

function getEntryStatusBadge(frontmatter: EntryFrontmatter | SearchEntry, now: Date = new Date()): EntryStatusBadge | null {
  const status = frontmatter.status;
  const stale = typeof frontmatter.revalidateAfter === "string"
    && !Number.isNaN(Date.parse(frontmatter.revalidateAfter))
    && Date.parse(frontmatter.revalidateAfter) < now.getTime();
  if (status === "deprecated" || status === "superseded") {
    return {
      label: status,
      tone: "deprecated",
      title: stale ? `${status} · stale` : status,
    };
  }
  if (stale) {
    return {
      label: "stale",
      tone: "stale",
      title: frontmatter.revalidateAfter ?? "stale",
    };
  }
  if (status === "current" || status === "draft") {
    return {
      label: status,
      tone: "neutral",
      title: status,
    };
  }
  return null;
}
