import { entryPath } from "../router";
import type { WikiIndexEntry } from "../api";

export type NavMode = "tags" | "entries";

interface TagGroup {
  tag: string;
  entries: WikiIndexEntry[];
}

const collapsedTags = new Set<string>();
let navMode: NavMode = "entries";

const COMPASS_MARK = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" opacity="0.16" />
    <path d="M12 3v3.6M12 17.4V21M3 12h3.6M17.4 12H21" />
    <path d="M12 8.6 14.2 12 12 15.4 9.8 12Z" fill="currentColor" stroke="none" />
  </svg>
`;

const SEARCH_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.5-3.5" />
  </svg>
`;

const CARET = `
  <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
`;

const CLOSE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="14" height="14">
    <path d="M6 6 18 18M18 6 6 18" />
  </svg>
`;

export function renderNavTree(entries: WikiIndexEntry[], currentId: string | null): string {
  const total = entries.length;
  const tagGroupCount = countTags(entries);
  const body = total === 0
    ? `<p class="empty-state">아직 위키 문서가 없습니다.</p>`
    : navMode === "tags"
      ? renderTagsView(entries, currentId)
      : renderEntriesView(entries, currentId);

  const sectionLabel = navMode === "tags"
    ? `Tags · ${tagGroupCount}`
    : `Entries · ${total}`;

  const navClass = navMode === "tags" ? "tag-tree" : "entry-list";
  const navAriaLabel = navMode === "tags" ? "태그별 문서" : "전체 문서 목록";

  return `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <a class="brand" href="/" data-action="navigate-home" aria-label="홈으로 이동">
          <span class="brand-mark">${COMPASS_MARK}</span>
          <div class="brand-text">
            <p class="eyebrow">Fleet · Codex</p>
            <h1>Knowledge</h1>
          </div>
        </a>
        <button class="icon-button mobile-close" type="button" data-action="toggle-nav" aria-label="닫기">${CLOSE_ICON}</button>
      </div>
      <button class="command-entry" type="button" data-action="open-command">
        <span class="command-entry-label">${SEARCH_ICON}<span>문서 검색</span></span>
        <kbd>⌘K</kbd>
      </button>
      <div class="nav-tabs" role="tablist" aria-label="탐색 모드">
        <button class="nav-tab${navMode === "entries" ? " active" : ""}" type="button" role="tab" aria-selected="${navMode === "entries"}" data-action="set-nav-mode" data-mode="entries">
          Entries
        </button>
        <button class="nav-tab${navMode === "tags" ? " active" : ""}" type="button" role="tab" aria-selected="${navMode === "tags"}" data-action="set-nav-mode" data-mode="tags">
          Tags
        </button>
      </div>
      <p class="nav-section-label">${sectionLabel}</p>
      <nav class="${navClass}" aria-label="${navAriaLabel}">
        ${body}
      </nav>
    </aside>
  `;
}

export function toggleTag(tag: string): void {
  if (collapsedTags.has(tag)) {
    collapsedTags.delete(tag);
    return;
  }
  collapsedTags.add(tag);
}

export function setNavMode(mode: NavMode): void {
  navMode = mode;
}

export function getNavMode(): NavMode {
  return navMode;
}

function countTags(entries: WikiIndexEntry[]): number {
  const tags = new Set<string>();
  for (const entry of entries) {
    if (entry.tags.length === 0) {
      tags.add("untagged");
      continue;
    }
    for (const tag of entry.tags) tags.add(tag);
  }
  return tags.size;
}

function renderTagsView(entries: WikiIndexEntry[], currentId: string | null): string {
  const groups = buildTagGroups(entries);
  return groups.map((group) => renderGroup(group, currentId)).join("");
}

function renderEntriesView(entries: WikiIndexEntry[], currentId: string | null): string {
  const sorted = [...entries].sort((left, right) => left.title.localeCompare(right.title));
  return sorted.map((entry) => renderEntry(entry, currentId)).join("");
}

function buildTagGroups(entries: WikiIndexEntry[]): TagGroup[] {
  const byTag = new Map<string, WikiIndexEntry[]>();
  for (const entry of entries) {
    const tags = entry.tags.length > 0 ? entry.tags : ["untagged"];
    for (const tag of tags) {
      const bucket = byTag.get(tag) ?? [];
      bucket.push(entry);
      byTag.set(tag, bucket);
    }
  }
  return [...byTag.entries()]
    .map(([tag, groupEntries]) => ({
      tag,
      entries: groupEntries.sort((left, right) => left.title.localeCompare(right.title)),
    }))
    .sort((left, right) => left.tag.localeCompare(right.tag));
}

function renderGroup(group: TagGroup, currentId: string | null): string {
  const collapsed = collapsedTags.has(group.tag);
  const entries = collapsed
    ? ""
    : group.entries.map((entry) => renderEntry(entry, currentId)).join("");
  return `
    <section class="tag-group" data-collapsed="${collapsed ? "true" : "false"}">
      <button class="tag-group-button" type="button" data-action="toggle-tag" data-tag="${escapeAttribute(group.tag)}">
        ${CARET}
        <span>${escapeHtml(group.tag)}</span>
        <span class="count">${group.entries.length}</span>
      </button>
      <div class="tag-group-list">${entries}</div>
    </section>
  `;
}

function renderEntry(entry: WikiIndexEntry, currentId: string | null): string {
  const activeClass = entry.id === currentId ? " active" : "";
  const safeTitle = escapeAttribute(entry.title);
  return `
    <a class="nav-entry${activeClass}" href="${entryPath(entry.id)}" data-entry-id="${escapeAttribute(entry.id)}" title="${safeTitle}">
      <span class="nav-entry-text">${escapeHtml(entry.title)}</span>
    </a>
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
