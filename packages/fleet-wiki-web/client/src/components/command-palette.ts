import { fetchSearch } from "../api";
import { entryPath, navigate } from "../router";
import type { BriefingHit, WikiIndexEntry } from "../api";

interface CommandPaletteState {
  open: boolean;
  query: string;
  selectedIndex: number;
  results: BriefingHit[];
  debounceId: number | null;
  searchSeq: number;
}

const state: CommandPaletteState = {
  open: false,
  query: "",
  selectedIndex: 0,
  results: [],
  debounceId: null,
  searchSeq: 0,
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
  state.open = true;
  state.query = "";
  state.selectedIndex = 0;
  state.results = defaultResults();
  mountPaletteShell();
  updatePaletteResults();
  window.setTimeout(() => {
    const input = document.querySelector<HTMLInputElement>("#command-input");
    if (!input) return;
    input.focus();
    input.select();
  }, 0);
}

export function closeCommandPalette(): void {
  state.open = false;
  if (state.debounceId !== null) {
    window.clearTimeout(state.debounceId);
    state.debounceId = null;
  }
  unmountPalette();
}

export function initCommandPalette(): void {
  document.addEventListener("keydown", handleDocumentKeydown);
  document.addEventListener("input", handleDocumentInput);
  document.addEventListener("click", handleDocumentClick);
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  const isCommandKey = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
  if (isCommandKey) {
    event.preventDefault();
    openCommandPalette();
    return;
  }
  if (!state.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeCommandPalette();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.selectedIndex = Math.min(state.selectedIndex + 1, Math.max(0, state.results.length - 1));
    syncPaletteHighlight();
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    state.selectedIndex = Math.max(0, state.selectedIndex - 1);
    syncPaletteHighlight();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const result = state.results[state.selectedIndex];
    if (!result) return;
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
    navigate(entryPath(item.dataset.commandEntryId ?? ""));
    closeCommandPalette();
  }
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
  list.innerHTML = state.results.length === 0
    ? `<p class="empty-state">검색 결과가 없습니다.</p>`
    : state.results.map(renderResult).join("");
}

function syncPaletteHighlight(): void {
  const buttons = document.querySelectorAll<HTMLElement>(".command-result");
  buttons.forEach((button, index) => {
    button.classList.toggle("active", index === state.selectedIndex);
  });
  const active = buttons[state.selectedIndex];
  active?.scrollIntoView({ block: "nearest" });
}

function paletteShellHtml(): string {
  return `
    <div class="command-overlay">
      <section class="command-card" role="dialog" aria-modal="true" aria-label="명령 팔레트">
        <div class="command-search">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input id="command-input" type="search" autocomplete="off" spellcheck="false" placeholder="제목 · 태그 · 본문 검색" />
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
  const tagsHtml = visibleTags
    .map((tag) => `<span class="chip chip-tag">${escapeHtml(tag)}</span>`)
    .join("");
  const overflowHtml = overflow > 0
    ? `<span class="chip chip-muted">+${overflow}</span>`
    : "";
  return `
    <button class="command-result${activeClass}" type="button" data-command-entry-id="${escapeAttribute(result.id)}" title="${safeTitle}">
      <span class="command-result-text">
        <strong>${escapeHtml(result.title)}</strong>
        <small>${escapeHtml(result.reason)} · score ${result.score}</small>
      </span>
      <span class="command-result-aside">${tagsHtml}${overflowHtml}</span>
    </button>
  `;
}

function defaultResults(): BriefingHit[] {
  const recentSet = new Set(recentIdsCache);
  const recent = recentIdsCache
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
