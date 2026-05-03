import { renderTagChips } from "./meta-chips";
import { entryPath } from "../router";
import type { WikiIndexEntry } from "../api";

interface RelatedEntry {
  entry: WikiIndexEntry;
  matchingTags: string[];
}

export function renderRelatedList(currentId: string, currentTags: string[], entries: WikiIndexEntry[]): string {
  const related = relatedEntries(currentId, currentTags, entries);
  if (related.length === 0) return "";
  return `
    <section class="related-list">
      <h2>관련 문서</h2>
      <div class="related-items">
        ${related.map((item) => `
          <a class="related-card" href="${entryPath(item.entry.id)}" data-entry-id="${escapeAttribute(item.entry.id)}">
            <strong>${escapeHtml(item.entry.title)}</strong>
            <span>${renderTagChips(item.matchingTags)}</span>
          </a>
        `).join("")}
      </div>
    </section>
  `;
}

function relatedEntries(currentId: string, currentTags: string[], entries: WikiIndexEntry[]): RelatedEntry[] {
  const tagSet = new Set(currentTags);
  return entries
    .filter((entry) => entry.id !== currentId)
    .map((entry) => ({
      entry,
      matchingTags: entry.tags.filter((tag) => tagSet.has(tag)),
    }))
    .filter((item) => item.matchingTags.length > 0)
    .sort((left, right) => right.matchingTags.length - left.matchingTags.length || left.entry.title.localeCompare(right.entry.title))
    .slice(0, 5);
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
