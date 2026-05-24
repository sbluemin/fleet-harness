import { conflictsPath, entryPath, indexMdPath, logPath, queuePath, workspaceHomePath } from "../router";
import type { WikiIndexEntry } from "../api";
import type { WorkspaceMetadata } from "../api";
import { t } from "../i18n/t";
import { getLanguage, languageLocale } from "../i18n/store";
import { renderLangToggle } from "./lang-toggle";

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

const ANCHOR_ICON = `
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="5" r="2" />
    <path d="M12 7v14M8 11H4a8 8 0 0 0 16 0h-4" />
  </svg>
`;

const WORKSPACE_LISTBOX_ID = "workspace-switcher-listbox";
const WORKSPACE_OPTION_PREFIX = "workspace-option-";

export function renderNavTree(
  entries: WikiIndexEntry[],
  currentId: string | null,
  pendingPatchCount: number,
  workspaces: WorkspaceMetadata[] = [],
  currentWorkspaceId: string | null = null,
  currentPathname?: string,
): string {
  const total = entries.length;
  const tagGroupCount = countTags(entries);
  const body = total === 0
    ? `<p class="empty-state">${t("nav.emptyEntries")}</p>`
    : navMode === "tags"
      ? renderTagsView(entries, currentId)
      : renderEntriesView(entries, currentId);

  const sectionLabel = navMode === "tags"
    ? t("nav.sectionTags", { n: tagGroupCount })
    : t("nav.sectionEntries", { n: total });

  const navClass = navMode === "tags" ? "tag-tree" : "entry-list";
  const navAriaLabel = navMode === "tags" ? t("nav.ariaTaggedDocs") : t("nav.ariaAllDocs");

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
        <a class="brand" href="/" data-action="navigate-home" aria-label="${t("nav.ariaHome")}">
          <span class="brand-mark">${COMPASS_MARK}</span>
          <div class="brand-text">
            <p class="eyebrow">Fleet · Codex</p>
            <h1>${t("nav.sidebarTitle")}</h1>
          </div>
        </a>
        <div class="sidebar-header-actions">
          ${renderLangToggle(getLanguage())}
          <button class="icon-button mobile-close" type="button" data-action="toggle-nav" aria-label="${t("nav.ariaClose")}">${CLOSE_ICON}</button>
        </div>
      </div>
      ${renderWorkspaceSwitcher(workspaces, currentWorkspaceId)}
      <button class="command-entry" type="button" data-action="open-command">
        <span class="command-entry-label">${SEARCH_ICON}<span>${t("nav.searchLabel")}</span></span>
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
      <div class="nav-tabs" role="tablist" aria-label="${t("nav.ariaNavMode")}">
        <button class="nav-tab${navMode === "entries" ? " active" : ""}" type="button" role="tab" aria-selected="${navMode === "entries"}" data-action="set-nav-mode" data-mode="entries">
          ${t("nav.tabEntries")}
        </button>
        <button class="nav-tab${navMode === "tags" ? " active" : ""}" type="button" role="tab" aria-selected="${navMode === "tags"}" data-action="set-nav-mode" data-mode="tags">
          ${t("nav.tabTags")}
        </button>
      </div>
      <p class="nav-section-label">${sectionLabel}</p>
      <nav class="${navClass}" aria-label="${navAriaLabel}">
        ${body}
      </nav>
    </aside>
  `;
}

function renderWorkspaceSwitcher(workspaces: WorkspaceMetadata[], currentWorkspaceId: string | null): string {
  if (workspaces.length === 0) return "";
  const current = workspaces.find((workspace) => workspace.id === currentWorkspaceId) ?? workspaces[0];
  const duplicateBasenames = findDuplicateBasenames(workspaces);
  const currentBasename = workspaceBasename(current);
  const currentTitle = workspaceTitle(current);
  if (workspaces.length === 1) {
    return `
      <div class="workspace-switcher workspace-switcher--single" title="${escapeAttribute(currentTitle)}">
        <span class="workspace-switcher-label">Workspace</span>
        <span class="workspace-chip">
          <span class="workspace-trigger-text">${escapeHtml(currentBasename)}</span>
        </span>
      </div>
    `;
  }
  return `
    <div class="workspace-switcher" data-workspace-switcher>
      <span class="workspace-switcher-label">Workspace</span>
      <button
        class="workspace-trigger"
        type="button"
        data-action="toggle-workspace-list"
        aria-label="Workspace"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-controls="${WORKSPACE_LISTBOX_ID}"
        aria-activedescendant="${workspaceOptionId(current.id)}"
        title="${escapeAttribute(currentTitle)}"
      >
        <span class="workspace-trigger-text">${escapeHtml(currentBasename)}</span>
        ${CARET}
      </button>
      <div class="workspace-listbox" id="${WORKSPACE_LISTBOX_ID}" role="listbox" aria-label="Workspace" hidden>
        ${workspaces.map((workspace) => `
          ${renderWorkspaceOption(workspace, workspace.id === current.id, duplicateBasenames.has(workspaceBasename(workspace)))}
        `).join("")}
      </div>
    </div>
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
  const locale = languageLocale();
  const sorted = [...entries].sort((left, right) =>
    left.title.localeCompare(right.title, locale, { sensitivity: "base", numeric: true }),
  );
  return sorted.map((entry) => renderEntry(entry, currentId)).join("");
}

function buildTagGroups(entries: WikiIndexEntry[]): TagGroup[] {
  const locale = languageLocale();
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
        <span>${group.tag === "untagged" ? t("nav.untagged") : escapeHtml(group.tag)}</span>
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

function renderWorkspaceOption(workspace: WorkspaceMetadata, isActive: boolean, needsSuffix: boolean): string {
  const suffix = needsSuffix
    ? `<span class="workspace-option-suffix" aria-hidden="true">· ${escapeHtml(workspace.id.slice(0, 6))}</span>`
    : "";
  return `
    <a
      class="workspace-option${isActive ? " active" : ""}"
      id="${workspaceOptionId(workspace.id)}"
      href="${escapeAttribute(workspaceHomePath(workspace.id))}"
      role="option"
      aria-selected="${isActive}"
      data-action="select-workspace"
      data-workspace-id="${escapeAttribute(workspace.id)}"
      title="${escapeAttribute(workspaceTitle(workspace))}"
    >
      <span class="workspace-option-label">${escapeHtml(workspace.label)}</span>
      ${suffix}
    </a>
  `;
}

function workspaceTitle(workspace: WorkspaceMetadata): string {
  return `${workspace.label} · ${workspace.cwd}`;
}

function workspaceBasename(workspace: WorkspaceMetadata): string {
  const normalized = workspace.cwd.replace(/[\\/]+$/, "");
  const basename = normalized.split(/[\\/]/).pop();
  return basename && basename.length > 0 ? basename : workspace.label;
}

function findDuplicateBasenames(workspaces: WorkspaceMetadata[]): Set<string> {
  const counts = new Map<string, number>();
  for (const workspace of workspaces) {
    const basename = workspaceBasename(workspace);
    counts.set(basename, (counts.get(basename) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([basename]) => basename));
}

function workspaceOptionId(workspaceId: string): string {
  return `${WORKSPACE_OPTION_PREFIX}${workspaceId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function installWorkspaceSwitcherHandlers(): void {
  if (typeof document === "undefined") return;
  document.addEventListener("click", handleWorkspaceSwitcherClick);
  document.addEventListener("keydown", handleWorkspaceSwitcherKeydown);
}

function handleWorkspaceSwitcherClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const switcher = target.closest<HTMLElement>("[data-workspace-switcher]");
  const action = target.closest<HTMLElement>("[data-action]");
  if (!switcher) {
    closeWorkspaceSwitchers();
    return;
  }
  if (action?.dataset.action === "toggle-workspace-list") {
    event.preventDefault();
    toggleWorkspaceSwitcher(switcher);
    return;
  }
  if (action?.dataset.action === "select-workspace") {
    const workspaceId = action.dataset.workspaceId;
    if (!workspaceId) return;
    event.preventDefault();
    window.location.assign(workspaceHomePath(workspaceId));
  }
}

function handleWorkspaceSwitcherKeydown(event: KeyboardEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const switcher = target.closest<HTMLElement>("[data-workspace-switcher]");
  if (!switcher) return;
  const options = workspaceOptions(switcher);
  if (options.length === 0) return;
  const currentIndex = Math.max(0, options.findIndex((option) => option === document.activeElement));
  if (event.key === "Escape") {
    closeWorkspaceSwitcher(switcher);
    workspaceTrigger(switcher)?.focus();
    event.preventDefault();
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    if (target.matches("[data-action='toggle-workspace-list']")) {
      openWorkspaceSwitcher(switcher);
      activeWorkspaceOption(switcher)?.focus();
      event.preventDefault();
      return;
    }
    if (target instanceof HTMLElement && target.dataset.action === "select-workspace") {
      const workspaceId = target.dataset.workspaceId;
      if (!workspaceId) return;
      event.preventDefault();
      window.location.assign(workspaceHomePath(workspaceId));
    }
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    openWorkspaceSwitcher(switcher);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = target.matches("[data-action='toggle-workspace-list']")
      ? Math.max(0, options.findIndex((option) => option.classList.contains("active")))
      : (currentIndex + delta + options.length) % options.length;
    options[nextIndex]?.focus();
    event.preventDefault();
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    openWorkspaceSwitcher(switcher);
    options[event.key === "Home" ? 0 : options.length - 1]?.focus();
    event.preventDefault();
  }
}

function toggleWorkspaceSwitcher(switcher: HTMLElement): void {
  const listbox = workspaceListbox(switcher);
  if (!listbox) return;
  if (listbox.hidden) {
    openWorkspaceSwitcher(switcher);
    return;
  }
  closeWorkspaceSwitcher(switcher);
}

function openWorkspaceSwitcher(switcher: HTMLElement): void {
  closeWorkspaceSwitchers(switcher);
  const listbox = workspaceListbox(switcher);
  const trigger = workspaceTrigger(switcher);
  if (!listbox || !trigger) return;
  listbox.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
}

function closeWorkspaceSwitcher(switcher: HTMLElement): void {
  const listbox = workspaceListbox(switcher);
  const trigger = workspaceTrigger(switcher);
  if (!listbox || !trigger) return;
  listbox.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
}

function closeWorkspaceSwitchers(except?: HTMLElement): void {
  for (const switcher of document.querySelectorAll<HTMLElement>("[data-workspace-switcher]")) {
    if (switcher !== except) closeWorkspaceSwitcher(switcher);
  }
}

function workspaceTrigger(switcher: HTMLElement): HTMLButtonElement | null {
  return switcher.querySelector<HTMLButtonElement>("[data-action='toggle-workspace-list']");
}

function workspaceListbox(switcher: HTMLElement): HTMLElement | null {
  return switcher.querySelector<HTMLElement>(".workspace-listbox");
}

function workspaceOptions(switcher: HTMLElement): HTMLAnchorElement[] {
  return [...switcher.querySelectorAll<HTMLAnchorElement>("[role='option']")];
}

function activeWorkspaceOption(switcher: HTMLElement): HTMLAnchorElement | null {
  return switcher.querySelector<HTMLAnchorElement>("[role='option'].active") ?? workspaceOptions(switcher)[0] ?? null;
}

function stripWorkspacePath(pathname: string): string {
  const match = pathname.match(/^\/w\/[^/]+(\/.*)?$/);
  return match ? match[1] ?? "/" : pathname;
}

installWorkspaceSwitcherHandlers();
