import { CODEX_BASE_PATH, conflictsPath, entryPath, indexMdPath, logPath, queuePath } from "../router";
import type { WikiIndexEntry } from "../api";
import { escapeAttribute, escapeHtml } from "../utils/html";

export type NavMode = "tags" | "entries";

interface TagGroup {
  tag: string;
  entries: WikiIndexEntry[];
}

const collapsedTags = new Set<string>();
let navMode: NavMode = "entries";

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

const ANCHOR_ICON = `
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="5" r="2" />
    <path d="M12 7v14M8 11H4a8 8 0 0 0 16 0h-4" />
  </svg>
`;

export function renderNavTree(
  entries: WikiIndexEntry[],
  currentId: string | null,
  pendingPatchCount: number,
  _workspaces: unknown[] = [],
  _currentWorkspaceId: string | null = null,
  currentPathname?: string,
): string {
  const total = entries.length;
  const tagGroupCount = countTags(entries);
  const body = total === 0
    ? `<p class="empty-state">No wiki entries yet.</p>`
    : navMode === "tags"
      ? renderTagsView(entries, currentId)
      : renderEntriesView(entries, currentId);

  const sectionLabel = navMode === "tags"
    ? `Tags · ${tagGroupCount}`
    : `Entries · ${total}`;

  const navClass = navMode === "tags" ? "tag-tree" : "entry-list";
  const navAriaLabel = navMode === "tags" ? "Entries by tag" : "All entries";

  const pathname = stripWorkspacePath(currentPathname ?? (typeof window !== "undefined" ? window.location.pathname : ""));
  const isDrydockActive = pathname.startsWith("/queue");
  const isIndexActive = pathname === "/index";
  const isLogActive = pathname === "/log";
  const isConflictsActive = pathname.startsWith("/conflicts");

  const pendingBadge = pendingPatchCount > 0
    ? `<span class="nav-drydock-badge">${pendingPatchCount}</span>`
    : "";

  return `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-header-actions">
          <button class="icon-button mobile-close" type="button" data-action="toggle-nav" aria-label="Close">${CLOSE_ICON}</button>
        </div>
      </div>
      <button class="command-entry" type="button" data-action="open-command">
        <span class="command-entry-label">${SEARCH_ICON}<span>Search entries</span></span>
        <kbd>⌘K</kbd>
      </button>
      <div class="nav-drydock-section">
        <a class="nav-drydock-link${isDrydockActive ? " active" : ""}" href="${escapeAttribute(queuePath())}">
          <span class="nav-drydock-icon">${ANCHOR_ICON}</span>
          <span class="nav-drydock-label">Drydock</span>
          ${pendingBadge}
        </a>
        <a class="nav-drydock-link${isIndexActive ? " active" : ""}" href="${escapeAttribute(indexMdPath())}">
          <span class="nav-drydock-label">Index</span>
        </a>
        <a class="nav-drydock-link${isLogActive ? " active" : ""}" href="${escapeAttribute(logPath())}">
          <span class="nav-drydock-label">Log</span>
        </a>
        <a class="nav-drydock-link${isConflictsActive ? " active" : ""}" href="${escapeAttribute(conflictsPath())}">
          <span class="nav-drydock-label">Conflicts</span>
        </a>
      </div>
      <div class="nav-tabs" role="tablist" aria-label="Navigation mode">
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

// 워크스페이스 스위처의 document 전역 클릭/키보드 리스너 등록.
// 부트스트랩 책임은 main.ts에 있다 — 모듈 평가 부수효과로 호출하지 말 것.
export function initNavTree(): void {
  if (typeof document === "undefined") return;
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
  const locale = "en-US";
  const sorted = [...entries].sort((left, right) =>
    left.title.localeCompare(right.title, locale, { sensitivity: "base", numeric: true }),
  );
  return sorted.map((entry) => renderEntry(entry, currentId)).join("");
}

function buildTagGroups(entries: WikiIndexEntry[]): TagGroup[] {
  const locale = "en-US";
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
      entries: groupEntries.sort((left, right) =>
        left.title.localeCompare(right.title, locale, { sensitivity: "base", numeric: true }),
      ),
    }))
    .sort((left, right) =>
      left.tag.localeCompare(right.tag, locale, { sensitivity: "base", numeric: true }),
    );
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
        <span>${group.tag === "untagged" ? "Untagged" : escapeHtml(group.tag)}</span>
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

function stripWorkspacePath(pathname: string): string {
  const withoutBase =
    pathname === CODEX_BASE_PATH || pathname === `${CODEX_BASE_PATH}/`
      ? "/"
      : pathname.startsWith(`${CODEX_BASE_PATH}/`)
        ? pathname.slice(CODEX_BASE_PATH.length) || "/"
        : pathname;
  const match = withoutBase.match(/^\/w\/[^/]+(\/.*)?$/);
  return match ? match[1] ?? "/" : withoutBase;
}
