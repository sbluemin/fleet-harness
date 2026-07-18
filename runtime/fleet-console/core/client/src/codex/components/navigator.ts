import { getState, subscribeState } from "../state.js";
import type { AppState } from "../state.js";
import type { WikiIndexEntry } from "../api.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type NavigatorRequest =
  | { kind: "entry"; id: string }
  | { kind: "drydock"; patchId?: string }
  | { kind: "conflicts"; id?: string }
  | { kind: "schema"; templateId?: string };

export interface NavigatorController {
  destroy(): void;
  setTheater(theaterId: string | null): void;
}

interface NavigatorOptions {
  initialTheaterId: string | null;
  onRequest: (r: NavigatorRequest) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SEARCH_DEBOUNCE_MS = 120;

// ─── Render helpers ───────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightMatch(text: string, query: string): string {
  if (!query) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return (
    escapeHtml(text.slice(0, idx)) +
    `<mark>${escapeHtml(text.slice(idx, idx + query.length))}</mark>` +
    escapeHtml(text.slice(idx + query.length))
  );
}

function renderTagChip(tag: string): string {
  return `<span class="codex-nav-tag">${escapeHtml(tag)}</span>`;
}

function renderEntry(entry: WikiIndexEntry, query: string, isCurrent: boolean): string {
  const tagMatches = query
    ? entry.tags.some((t) => t.toLowerCase().includes(query.toLowerCase()))
    : false;
  const tags = entry.tags.slice(0, 3).map(renderTagChip).join("");
  const kind = escapeHtml(entry.status ?? "current");
  const updated = escapeHtml(entry.updated ?? "");

  return `<button
    class="codex-nav-entry${isCurrent ? " is-current" : ""}"
    data-entry-id="${escapeHtml(entry.id)}"
    type="button"
    ${isCurrent ? 'aria-current="page"' : ""}
    title="${escapeHtml(entry.title)}"
  >
    <span class="t">${highlightMatch(entry.title, tagMatches ? "" : query)}</span>
    ${tags ? `<span class="tg">${tags}</span>` : ""}
    <span class="meta">${kind} · ${updated}</span>
  </button>`;
}

function filterEntries(entries: WikiIndexEntry[], query: string): WikiIndexEntry[] {
  if (!query) return entries;
  const q = query.toLowerCase();
  return entries.filter(
    (e) =>
      e.title.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountNavigatorInto(
  root: HTMLElement,
  options: NavigatorOptions,
): NavigatorController {
  let currentQuery = "";
  let currentEntryId: string | null = null;
  let mode: "entries" | "schema" = "entries";
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // 단일 컬럼 Navigator 셸 삽입
  root.innerHTML = `
    <div class="codex-navigator">
      <div class="codex-nav-modes" role="tablist" aria-label="Codex catalog">
        <button type="button" role="tab" data-mode="entries" aria-selected="true">Entries</button>
        <button type="button" role="tab" data-mode="schema" aria-selected="false">Schema</button>
      </div>
      <div class="codex-nav-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
        <input
          class="codex-nav-search-input"
          type="search"
          placeholder="Search entries"
          autocomplete="off"
          spellcheck="false"
          aria-label="Search Codex entries"
        />
      </div>
      <div class="codex-nav-quick-row">
        <button class="codex-nav-quick" data-action="drydock" type="button">
          Review queue <span class="badge" id="codex-nav-drydock-badge">0</span>
        </button>
        <button class="codex-nav-quick" data-action="conflicts" type="button">Conflicts</button>
      </div>
      <div class="codex-nav-list-eyebrow" id="codex-nav-eyebrow">Entries · 0</div>
      <div class="codex-navigator-scroll">
        <div class="codex-nav-list" id="codex-nav-list"></div>
      </div>
    </div>
  `;

  const searchInput = root.querySelector<HTMLInputElement>(".codex-nav-search-input")!;
  const navList = root.querySelector<HTMLElement>("#codex-nav-list")!;
  const eyebrow = root.querySelector<HTMLElement>("#codex-nav-eyebrow")!;
  const drydockBadge = root.querySelector<HTMLElement>("#codex-nav-drydock-badge")!;

  function renderList(state: AppState): void {
    root.querySelectorAll<HTMLElement>("[data-mode]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.mode === mode)));
    searchInput.hidden = mode === "schema";
    if (mode === "schema") {
      const catalog = state.schemaCatalog;
      eyebrow.textContent = `Schema · ${catalog?.templates.length ?? 0} templates`;
      navList.innerHTML = catalog ? `
        <button class="codex-nav-entry" type="button" ${catalog.schema.exists ? 'data-schema-resource="workspace"' : 'disabled aria-disabled="true"'}><span class="t">Workspace schema</span><span class="meta">${catalog.schema.exists ? escapeHtml(catalog.schema.ref) : "Unavailable"}</span></button>
        ${catalog.templates.map((template) => `<button class="codex-nav-entry" type="button" data-template-id="${escapeHtml(template.id)}"><span class="t">${escapeHtml(template.id)}</span><span class="meta">${escapeHtml(template.ref)}</span></button>`).join("")}` : `<div class="codex-nav-empty">Schema catalog unavailable.</div>`;
      drydockBadge.textContent = String(state.pendingPatchCount);
      return;
    }
    const filtered = filterEntries(state.index, currentQuery);
    eyebrow.textContent = `Entries · ${filtered.length}`;
    drydockBadge.textContent = String(state.pendingPatchCount);
    drydockBadge.hidden = state.pendingPatchCount === 0;

    if (state.loading && state.index.length === 0) {
      navList.innerHTML = `<div class="codex-nav-loading" aria-live="polite">Loading…</div>`;
      return;
    }
    if (state.error) {
      navList.innerHTML = `<div class="codex-nav-error" role="alert">${escapeHtml(state.error)}</div>`;
      return;
    }
    if (filtered.length === 0) {
      navList.innerHTML = `<div class="codex-nav-empty">${currentQuery ? "No entries match." : "No entries."}</div>`;
      return;
    }
    navList.innerHTML = filtered
      .map((e) => renderEntry(e, currentQuery, e.id === currentEntryId))
      .join("");
  }

  // 클릭 위임
  function handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const modeBtn = target.closest<HTMLElement>("[data-mode]");
    if (modeBtn?.dataset.mode === "entries" || modeBtn?.dataset.mode === "schema") {
      mode = modeBtn.dataset.mode;
      renderList(getState());
      return;
    }
    const schemaBtn = target.closest<HTMLElement>("[data-schema-resource]");
    if (schemaBtn) { options.onRequest({ kind: "schema" }); return; }
    const templateBtn = target.closest<HTMLElement>("[data-template-id]");
    if (templateBtn?.dataset.templateId) { options.onRequest({ kind: "schema", templateId: templateBtn.dataset.templateId }); return; }

    const entryBtn = target.closest<HTMLElement>("[data-entry-id]");
    if (entryBtn?.dataset.entryId) {
      currentEntryId = entryBtn.dataset.entryId;
      renderList(getState());
      options.onRequest({ kind: "entry", id: currentEntryId });
      return;
    }

    const quickBtn = target.closest<HTMLElement>("[data-action]");
    if (quickBtn?.dataset.action === "drydock") {
      options.onRequest({ kind: "drydock" });
      return;
    }
    if (quickBtn?.dataset.action === "conflicts") {
      options.onRequest({ kind: "conflicts" });
      return;
    }
  }

  function handleSearchInput(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentQuery = searchInput.value;
      renderList(getState());
    }, SEARCH_DEBOUNCE_MS);
  }

  root.addEventListener("click", handleClick);
  searchInput.addEventListener("input", handleSearchInput);

  // 상태 구독
  const unsubscribe = subscribeState((state) => renderList(state));

  // 초기 렌더
  renderList(getState());

  return {
    destroy(): void {
      unsubscribe();
      root.removeEventListener("click", handleClick);
      searchInput.removeEventListener("input", handleSearchInput);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      root.innerHTML = "";
    },
    setTheater(_theaterId: string | null): void {
      // Theater 전환 시 검색 초기화 후 재렌더
      currentQuery = "";
      currentEntryId = null;
      if (searchInput) searchInput.value = "";
      renderList(getState());
    },
  };
}
