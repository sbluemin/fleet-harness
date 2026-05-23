import { fetchSearch } from "../api";
import { entryPath, navigate } from "../router";
import { rememberMatchHint } from "../state";
import type { BriefingHit, WikiIndexEntry } from "../api";
import { t } from "../i18n/t";

interface CommandPaletteState {
  open: boolean;
  query: string;
  selectedIndex: number;
  results: BriefingHit[];
  debounceId: number | null;
  searchSeq: number;
  previousBodyOverflow: string | null;
  previousActiveElement: HTMLElement | null;
}

const state: CommandPaletteState = {
  open: false,
  query: "",
  selectedIndex: 0,
  results: [],
  debounceId: null,
  searchSeq: 0,
  previousBodyOverflow: null,
  previousActiveElement: null,
};

let indexCache: WikiIndexEntry[] = [];
let recentIdsCache: string[] = [];

export function configureCommandPalette(index: WikiIndexEntry[], recentIds: string[]): void {
  indexCache = index;
  recentIdsCache = recentIds;
  if (state.open && !state.query) {
    state.results = defaultResults();
    state.selectedIndex = 0;
    updatePaletteResults();
  }
}

export function openCommandPalette(): void {
  if (state.open) {
    focusCommandInput();
    return;
  }
  state.open = true;
  state.query = "";
  state.selectedIndex = 0;
  state.results = defaultResults();
  state.previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  lockBodyScroll();
  mountPaletteShell();
  updatePaletteResults();
  focusCommandInput();
}

export function closeCommandPalette(): void {
  if (!state.open) return;
  state.open = false;
  state.searchSeq++;
  if (state.debounceId !== null) {
    window.clearTimeout(state.debounceId);
    state.debounceId = null;
  }
  unmountPalette();
  restoreBodyScroll();
  restorePreviousFocus();
}

export function initCommandPalette(): void {
  document.addEventListener("keydown", handleDocumentKeydown);
  document.addEventListener("input", handleDocumentInput);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("mouseover", handleDocumentMouseover);
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  const isCommandKey = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
  if (isCommandKey) {
    event.preventDefault();
    if (state.open) {
      closeCommandPalette();
    } else {
      openCommandPalette();
    }
    return;
  }
  if (!state.open) return;
  if (event.key === "Tab") {
    trapCommandPaletteFocus(event);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeCommandPalette();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.selectedIndex = Math.min(state.selectedIndex + 1, Math.max(0, state.results.length - 1));
    syncPaletteHighlight({ scroll: true });
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    state.selectedIndex = Math.max(0, state.selectedIndex - 1);
    syncPaletteHighlight({ scroll: true });
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const result = state.results[state.selectedIndex];
    if (!result) return;
    rememberMatchHint(result);
    navigate(entryPath(result.id));
    closeCommandPalette();
  }
}

function handleDocumentInput(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.id !== "command-input") return;
  state.query = target.value.trim();
  state.selectedIndex = 0;
  if (state.debounceId !== null) window.clearTimeout(state.debounceId);
  state.debounceId = window.setTimeout(() => {
    void runSearch(state.query);
  }, 150);
}

function handleDocumentClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.matches("[data-action='open-command']") || target.closest("[data-action='open-command']")) {
    openCommandPalette();
    return;
  }
  if (!state.open) return;
  if (target.classList.contains("command-overlay")) {
    closeCommandPalette();
    return;
  }
  const item = target.closest<HTMLElement>("[data-command-entry-id]");
  if (item) {
    const hit = state.results.find((result) => result.id === (item.dataset.commandEntryId ?? ""));
    rememberMatchHint(hit ?? null);
    navigate(entryPath(item.dataset.commandEntryId ?? ""));
    closeCommandPalette();
  }
}

function handleDocumentMouseover(event: MouseEvent): void {
  if (!state.open) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const item = target.closest<HTMLElement>("[data-command-index]");
  if (!item) return;
  const index = Number(item.dataset.commandIndex);
  if (!Number.isInteger(index) || index < 0 || index >= state.results.length) return;
  state.selectedIndex = index;
  syncPaletteHighlight({ scroll: false });
}

async function runSearch(query: string): Promise<void> {
  const seq = ++state.searchSeq;
  if (!query) {
    state.results = defaultResults();
    state.selectedIndex = 0;
    updatePaletteResults();
    return;
  }
  let results: BriefingHit[];
  try {
    results = await fetchSearch(query);
  } catch {
    results = [];
  }
  if (seq !== state.searchSeq || !state.open) return;
  state.results = results;
  state.selectedIndex = 0;
  updatePaletteResults();
}

function ensurePaletteRoot(): HTMLElement {
  let root = document.querySelector<HTMLElement>("#command-palette-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "command-palette-root";
    document.body.append(root);
  }
  return root;
}

function mountPaletteShell(): void {
  const root = ensurePaletteRoot();
  if (root.querySelector(".command-overlay")) return;
  root.innerHTML = paletteShellHtml();
}

function unmountPalette(): void {
  const root = document.querySelector<HTMLElement>("#command-palette-root");
  if (!root) return;
  root.innerHTML = "";
}

function updatePaletteResults(): void {
  const list = document.querySelector<HTMLElement>("#command-results-list");
  if (!list) return;
  if (state.results.length === 0) {
    list.innerHTML = `<p class="empty-state">${escapeHtml(t("command.emptyResults"))}</p>`;
    return;
  }
  list.innerHTML = state.query ? state.results.map(renderResult).join("") : renderDefaultResults();
}

function syncPaletteHighlight(options: { scroll: boolean } = { scroll: true }): void {
  const buttons = document.querySelectorAll<HTMLElement>(".command-result");
  buttons.forEach((button, index) => {
    button.classList.toggle("active", index === state.selectedIndex);
  });
  const active = buttons[state.selectedIndex];
  if (options.scroll) active?.scrollIntoView({ block: "nearest" });
}

function paletteShellHtml(): string {
  const ariaLabel = escapeAttribute(t("command.ariaLabel"));
  const placeholder = escapeAttribute(t("command.placeholder"));
  return `
    <div class="command-overlay">
      <section class="command-card" role="dialog" aria-modal="true" aria-label="${ariaLabel}" tabindex="-1">
        <div class="command-search">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input id="command-input" type="search" autocomplete="off" spellcheck="false" placeholder="${placeholder}" />
          <kbd>esc</kbd>
        </div>
        <div class="command-results" id="command-results-list"></div>
      </section>
    </div>
  `;
}

function renderResult(result: BriefingHit, index: number): string {
  const activeClass = index === state.selectedIndex ? " active" : "";
  const safeTitle = escapeAttribute(result.title);
  const visibleTags = result.tags.slice(0, 2);
  const overflow = result.tags.length - visibleTags.length;
  const excerpt = selectSnippet(result);
  const tagsHtml = visibleTags
    .map((tag) => `<span class="chip chip-tag">${escapeHtml(tag)}</span>`)
    .join("");
  const overflowHtml = overflow > 0
    ? `<span class="chip chip-muted">+${overflow}</span>`
    : "";
  return `
    <button class="command-result${activeClass}" type="button" data-command-entry-id="${escapeAttribute(result.id)}" data-command-index="${index}" title="${safeTitle}">
      <span class="command-result-text">
        <strong>${renderHighlightedTitle(result.title, state.query)}</strong>
        <small>${escapeHtml(formatMatchLocation(result))}</small>
        ${excerpt ? `<small class="command-result-excerpt">${escapeHtml(excerpt)}</small>` : ""}
      </span>
      <span class="command-result-aside">${tagsHtml}${overflowHtml}</span>
    </button>
  `;
}

function renderDefaultResults(): string {
  const recentCount = getRecentResultCount();
  const recentResults = state.results.slice(0, recentCount);
  const allResults = state.results.slice(recentCount);
  return [
    recentResults.length > 0 ? renderDefaultSection(t("command.recentSection"), recentResults, 0) : "",
    allResults.length > 0 ? renderDefaultSection(t("command.allSection"), allResults, recentCount) : "",
  ].join("");
}

function renderDefaultSection(label: string, results: BriefingHit[], offset: number): string {
  return `
    <div class="command-section-heading">${escapeHtml(label)}</div>
    ${results.map((result, index) => renderResult(result, offset + index)).join("")}
  `;
}

function defaultResults(): BriefingHit[] {
  const recentSet = new Set(recentIdsCache);
  const recent = uniqueRecentIds()
    .map((id) => indexCache.find((entry) => entry.id === id))
    .filter((entry): entry is WikiIndexEntry => Boolean(entry));
  const rest = indexCache.filter((entry) => !recentSet.has(entry.id));
  return [...recent, ...rest].slice(0, 8).map((entry, index) => ({
    id: entry.id,
    title: entry.title,
    score: Math.max(1, 100 - index),
    reason: "title",
    excerpt: "",
    path: entry.path,
    tags: entry.tags,
    updated: entry.updated,
  }));
}

function getRecentResultCount(): number {
  return uniqueRecentIds()
    .filter((id, index) => state.results[index]?.id === id)
    .length;
}

function uniqueRecentIds(): string[] {
  return Array.from(new Set(recentIdsCache));
}

function lockBodyScroll(): void {
  if (state.previousBodyOverflow !== null) return;
  state.previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
}

function restoreBodyScroll(): void {
  if (state.previousBodyOverflow === null) return;
  document.body.style.overflow = state.previousBodyOverflow;
  state.previousBodyOverflow = null;
}

function restorePreviousFocus(): void {
  const previous = state.previousActiveElement;
  state.previousActiveElement = null;
  if (!previous?.isConnected) return;
  previous.focus();
}

function focusCommandInput(): void {
  window.setTimeout(() => {
    const input = document.querySelector<HTMLInputElement>("#command-input");
    if (!input) return;
    input.focus();
    input.select();
  }, 0);
}

function trapCommandPaletteFocus(event: KeyboardEvent): void {
  const card = document.querySelector<HTMLElement>(".command-card");
  if (!card) return;
  const focusable = getCommandFocusableElements(card);
  if (focusable.length === 0) {
    event.preventDefault();
    card.focus();
    return;
  }
  const current = document.activeElement;
  const currentIndex = current instanceof HTMLElement ? focusable.indexOf(current) : -1;
  const nextIndex = event.shiftKey
    ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
    : (currentIndex === -1 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
  if (
    currentIndex === -1
    || (event.shiftKey && currentIndex === 0)
    || (!event.shiftKey && currentIndex === focusable.length - 1)
  ) {
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }
}

function getCommandFocusableElements(root: HTMLElement): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(root.querySelectorAll<HTMLElement>(selector))
    .filter((element) => !element.hasAttribute("hidden") && element.offsetParent !== null);
}

function renderHighlightedTitle(title: string, query: string): string {
  if (!query) return escapeHtml(title);
  const lowerTitle = title.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  if (!lowerQuery) return escapeHtml(title);
  let cursor = 0;
  let html = "";
  while (cursor < title.length) {
    const matchIndex = lowerTitle.indexOf(lowerQuery, cursor);
    if (matchIndex === -1) break;
    html += escapeHtml(title.slice(cursor, matchIndex));
    html += `<mark class="command-highlight">${escapeHtml(title.slice(matchIndex, matchIndex + query.length))}</mark>`;
    cursor = matchIndex + query.length;
  }
  return html + escapeHtml(title.slice(cursor));
}

function formatMatchLocation(result: BriefingHit): string {
  switch (result.reason) {
    case "id":
      return t("command.matchId");
    case "alias":
      return t("command.matchAlias");
    case "tag":
      return t("command.matchTag");
    case "title":
      return t("command.matchTitle");
    case "body":
      return t("command.matchBody");
    default:
      return t("command.matchOther");
  }
}

function selectSnippet(result: BriefingHit): string {
  const bodySnippet = result.matchedSnippets?.find((snippet) => snippet.field === "body")?.snippet;
  if (result.reason !== "body") return "";
  const snippet = bodySnippet ?? result.excerpt;
  return normalizeSnippet(snippet ?? "");
}

function normalizeSnippet(value: string): string {
  return stripWikiBoundaryMarkers(value).replace(/\s+/g, " ").trim().slice(0, 180);
}

function stripWikiBoundaryMarkers(value: string): string {
  return value.replace(/<<<[^>]*>>>/g, " ");
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
