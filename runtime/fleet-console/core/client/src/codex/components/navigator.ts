import { getGlobalSettingsStoreState } from "../../global-settings-store.js";
import { getT } from "../../i18n/index.js";
import { resolveConsoleLanguage } from "../../whatsnew-i18n.js";
import { formatRelativeUpdated, getEntryStatusBadge } from "./meta-chips.js";
import { fetchHealth, fetchSearch } from "../api.js";
import { getState, subscribeState } from "../state.js";
import type { AppState } from "../state.js";
import type { CodexHealthResponse, SearchEntry, WikiIndexEntry } from "../api.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type NavigatorRequest =
  | { kind: "entry"; id: string }
  | { kind: "drydock"; patchId?: string }
  | { kind: "conflicts"; id?: string }
  | { kind: "schema"; templateId?: string };

export interface NavigatorController {
  destroy(): void;
  setTheater(theaterId: string | null): void;
  setCurrentEntry(entryId: string | null): void;
  /** 리더 문서의 태그 칩 등 바깥 표면이 카탈로그 태그 필터를 직접 건다. */
  setActiveTag(tag: string | null): void;
  refreshHealth(): void;
  /** 로케일 변경 시 셸·목록 문구를 다시 그린다(검색·선택 상태 유지). */
  refreshLocale(): void;
}

interface NavigatorOptions {
  initialTheaterId: string | null;
  onRequest: (r: NavigatorRequest) => void;
}

interface RenderEntryOptions {
  activeTag: string | null;
  isCurrent: boolean;
  query: string;
  snippet?: string;
}

type SortOrder = "updated" | "name";

// ─── Constants ────────────────────────────────────────────────────────────────

const SEARCH_DEBOUNCE_MS = 120;
const SORT_STORAGE_KEY = "fleet.codex.navigator.sort";

function resolveActiveLocale() {
  const preference = getGlobalSettingsStoreState().state?.language ?? "auto";
  const navigatorLanguage =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language.toLowerCase()
      : "";
  return resolveConsoleLanguage(preference, navigatorLanguage);
}

function consoleT() {
  return getT(resolveActiveLocale());
}

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

function renderTagChip(tag: string, isActive: boolean): string {
  const t = consoleT();
  const label = isActive
    ? t("codex.nav.clearTagFilter", { tag })
    : t("codex.nav.filterByTag", { tag });
  return `<button class="codex-nav-tag${isActive ? " is-active" : ""}" data-tag="${escapeHtml(tag)}" type="button" aria-pressed="${String(isActive)}" aria-label="${escapeHtml(label)}">${escapeHtml(tag)}</button>`;
}

function renderEntry(entry: WikiIndexEntry, options: RenderEntryOptions): string {
  const tagMatches = options.query
    ? entry.tags.some((tag) => tag.toLowerCase().includes(options.query.toLowerCase()))
    : false;
  const tags = entry.tags
    .slice(0, 3)
    .map((tag) => renderTagChip(tag, tag === options.activeTag))
    .join("");
  const overflowTags = entry.tags.slice(3);
  const more = overflowTags.length > 0
    ? `<span class="codex-nav-more" title="${escapeHtml(overflowTags.join(", "))}" aria-hidden="true">+${overflowTags.length}</span>`
    : "";
  const updated = entry.updated ?? "";

  // 행 우측 한 칸은 변별 정보만 싣는다 — current는 그룹 헤더가 이미 말하므로 시간을,
  // 예외 상태(초안·폐기·낡음)는 그 배지를 싣는다(전체 시각은 title 툴팁에 보존).
  const badge = getEntryStatusBadge(entry);
  const aside = badge
    ? `<span class="codex-nav-status is-${badge.tone}" title="${escapeHtml(badge.title)}">${escapeHtml(badge.label)}</span>`
    : `<span class="when" title="${escapeHtml(updated)}">${escapeHtml(formatRelativeUpdated(updated))}</span>`;

  return `<div
    class="codex-nav-entry${options.isCurrent ? " is-current" : ""}"
    data-entry-id="${escapeHtml(entry.id)}"
    tabindex="-1"
    ${options.isCurrent ? 'aria-current="page"' : ""}
  >
    <button class="t" type="button" title="${escapeHtml(entry.title)}">${highlightMatch(entry.title, tagMatches ? "" : options.query)}</button>
    ${aside}
    ${tags ? `<span class="tg">${tags}${more}</span>` : ""}
    ${options.snippet ? `<span class="snippet">${highlightMatch(options.snippet, options.query)}</span>` : ""}
  </div>`;
}

const FRESH_WINDOW_MS = 7 * 86_400_000;
const DORMANT_STATUSES = new Set(["draft", "deprecated", "superseded"]);

// 신선도 그룹 — "이번 주 무엇이 바뀌었나"를 목록 최상단에서 답한다.
// draft·폐기 계열은 신선해도 하단 그룹에 묶어 현행 지식과 섞이지 않게 한다.
function renderGroupedEntries(
  merged: Array<{ entry: WikiIndexEntry; snippet: string | undefined }>,
  renderRow: (item: { entry: WikiIndexEntry; snippet: string | undefined }) => string,
  t: ReturnType<typeof consoleT>,
): string {
  const now = Date.now();
  const fresh: typeof merged = [];
  const current: typeof merged = [];
  const dormant: typeof merged = [];
  for (const item of merged) {
    const status = item.entry.status ?? "current";
    if (DORMANT_STATUSES.has(status)) {
      dormant.push(item);
      continue;
    }
    const updatedMs = new Date(item.entry.updated).getTime();
    if (!Number.isNaN(updatedMs) && now - updatedMs <= FRESH_WINDOW_MS) fresh.push(item);
    else current.push(item);
  }
  const sections: Array<{ label: string; items: typeof merged; dormant?: boolean }> = [
    { label: t("codex.nav.groupFresh"), items: fresh },
    { label: t("codex.nav.groupCurrent"), items: current },
    { label: t("codex.nav.groupDormant"), items: dormant, dormant: true },
  ];
  return sections
    .filter((section) => section.items.length > 0)
    .map((section) => `
      <div class="codex-nav-group${section.dormant ? " is-dormant" : ""}">
        <div class="codex-nav-group-head"><span>${escapeHtml(section.label)}</span><span class="codex-nav-group-count">${section.items.length}</span></div>
        ${section.items.map(renderRow).join("")}
      </div>`)
    .join("");
}

function filterEntries(entries: WikiIndexEntry[], query: string, activeTag: string | null): WikiIndexEntry[] {
  const q = query.toLowerCase();
  return entries.filter((entry) => {
    const matchesQuery = !query ||
      entry.title.toLowerCase().includes(q) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(q));
    return matchesQuery && (!activeTag || entry.tags.includes(activeTag));
  });
}

function sortEntries(entries: WikiIndexEntry[], sortOrder: SortOrder): WikiIndexEntry[] {
  const locale = resolveActiveLocale();
  return [...entries].sort((left, right) => {
    if (sortOrder === "name") return left.title.localeCompare(right.title, locale);
    const leftTime = new Date(left.updated).getTime();
    const rightTime = new Date(right.updated).getTime();
    const byUpdated = (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
    return byUpdated || left.title.localeCompare(right.title, locale);
  });
}

function readSortOrder(): SortOrder {
  try {
    return localStorage.getItem(SORT_STORAGE_KEY) === "name" ? "name" : "updated";
  } catch {
    return "updated";
  }
}

function saveSortOrder(sortOrder: SortOrder): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, sortOrder);
  } catch {
    // Storage is optional.
  }
}

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountNavigatorInto(
  root: HTMLElement,
  options: NavigatorOptions,
): NavigatorController {
  let currentQuery = "";
  let currentEntryId: string | null = null;
  let activeTag: string | null = null;
  let activeTheaterId = options.initialTheaterId;
  let serverResults: SearchEntry[] = [];
  let sortOrder = readSortOrder();
  let mode: "entries" | "schema" = "entries";
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let searchController: AbortController | null = null;
  let healthController: AbortController | null = null;
  let searchEpoch = 0;
  let healthEpoch = 0;
  let health: CodexHealthResponse | null = null;
  let healthPopoverOpen = false;

  function renderShell(): void {
    const t = consoleT();
    root.innerHTML = `
    <div class="codex-navigator">
      <div class="codex-nav-modes" role="tablist" aria-label="${escapeHtml(t("codex.nav.catalogAria"))}">
        <button type="button" role="tab" data-mode="entries" aria-selected="true">${escapeHtml(t("codex.nav.entries"))}</button>
        <button type="button" role="tab" data-mode="schema" aria-selected="false">${escapeHtml(t("codex.nav.schema"))}</button>
      </div>
      <div class="codex-nav-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
        <input
          class="codex-nav-search-input"
          type="search"
          placeholder="${escapeHtml(t("codex.nav.searchPlaceholder"))}"
          autocomplete="off"
          spellcheck="false"
          aria-label="${escapeHtml(t("codex.nav.searchAria"))}"
        />
      </div>
      <div class="codex-nav-quick-row">
        <button class="codex-nav-quick" data-action="drydock" type="button">
          ${escapeHtml(t("codex.nav.reviewQueue"))} <span class="badge" id="codex-nav-drydock-badge">0</span>
        </button>
        <button class="codex-nav-quick" data-action="conflicts" type="button">${escapeHtml(t("codex.nav.conflicts"))} <span class="badge" id="codex-nav-conflict-badge" hidden>0</span></button>
        <div class="codex-nav-health" hidden></div>
      </div>
      <div class="codex-nav-list-header">
        <div class="codex-nav-list-summary">
          <span class="codex-nav-list-eyebrow" id="codex-nav-eyebrow">${escapeHtml(t("codex.nav.entriesCount", { count: 0 }))}</span>
          <button class="codex-nav-active-filter" data-clear-tag type="button" hidden></button>
        </div>
        <div class="codex-nav-sort" role="group" aria-label="${escapeHtml(t("codex.nav.sortAria"))}">
          <button data-sort="updated" type="button" aria-pressed="true">${escapeHtml(t("codex.nav.sortUpdated"))}</button>
          <button data-sort="name" type="button" aria-pressed="false">${escapeHtml(t("codex.nav.sortName"))}</button>
        </div>
      </div>
      <div class="codex-navigator-scroll">
        <div class="codex-nav-list" id="codex-nav-list"></div>
      </div>
    </div>
  `;
  }

  renderShell();

  const searchInput = root.querySelector<HTMLInputElement>(".codex-nav-search-input")!;
  const navList = root.querySelector<HTMLElement>("#codex-nav-list")!;
  const eyebrow = root.querySelector<HTMLElement>("#codex-nav-eyebrow")!;
  const drydockBadge = root.querySelector<HTMLElement>("#codex-nav-drydock-badge")!;
  const activeFilterButton = root.querySelector<HTMLButtonElement>("[data-clear-tag]")!;
  const conflictBadge = root.querySelector<HTMLElement>("#codex-nav-conflict-badge")!;
  const sortControls = root.querySelector<HTMLElement>(".codex-nav-sort")!;
  const healthStrip = root.querySelector<HTMLElement>(".codex-nav-health")!;

  function renderHealth(): void {
    const t = consoleT();
    const drydock = health?.lastDrydock ?? null;
    const issueCount = drydock?.issueCount ?? 0;
    const logUnreadable = health?.logUnreadable === true;
    // 문장형 스트립은 좁은 폭에서 잘려 나갔다 — 항상 보이는 응축 칩으로 바꾸고
    // 세부는 팝오버가 계속 담당한다. 충돌 수는 충돌 칩의 배지로 옮긴다.
    conflictBadge.textContent = String(health?.conflictCount ?? 0);
    conflictBadge.hidden = (health?.conflictCount ?? 0) === 0;
    healthStrip.hidden = health === null;
    if (!health) {
      healthStrip.innerHTML = "";
      return;
    }
    const attention = logUnreadable || (drydock !== null && (!drydock.ok || issueCount > 0));
    const tone = (drydock?.errorCount ?? 0) > 0 ? "coral" : attention ? "warn" : "ok";
    const label = logUnreadable
      ? t("codex.nav.healthLogUnreadable")
      : attention
        ? t("codex.nav.healthIssues", { count: issueCount })
        : t("codex.nav.healthOk");
    const timestamp = drydock ? new Date(drydock.at).toLocaleString(resolveActiveLocale()) : t("codex.nav.healthNever");
    healthStrip.innerHTML = `
      <button class="codex-nav-health-chip" data-health-detail type="button" aria-expanded="${String(healthPopoverOpen)}" aria-label="${escapeHtml(t("codex.nav.healthDetailsAria"))}">
        <span class="codex-nav-health-dot is-${tone}" aria-hidden="true"></span>${escapeHtml(label)}
      </button>
      ${healthPopoverOpen ? `<div class="codex-nav-health-popover" role="dialog" aria-label="${escapeHtml(t("codex.nav.healthDetailsAria"))}">
        ${logUnreadable ? `<div><span>${escapeHtml(t("codex.nav.healthLogUnreadable"))}</span><strong>${escapeHtml(t("codex.nav.healthAttention"))}</strong></div>` : ""}
        <div><span>${escapeHtml(t("codex.nav.healthErrors"))}</span><strong>${drydock?.errorCount ?? 0}</strong></div>
        <div><span>${escapeHtml(t("codex.nav.healthWarnings"))}</span><strong>${drydock?.warningCount ?? 0}</strong></div>
        <div><span>${escapeHtml(t("codex.nav.healthInfos"))}</span><strong>${drydock?.infoCount ?? 0}</strong></div>
        <div><span>${escapeHtml(t("codex.nav.healthConflicts"))}</span><strong>${health.conflictCount}</strong></div>
        <div><span>${escapeHtml(t("codex.nav.healthPending"))}</span><strong>${health.pendingCount}</strong></div>
        <p>${escapeHtml(t("codex.nav.healthRanAt", { at: timestamp }))}</p>
      </div>` : ""}
    `;
  }

  function loadHealth(): void {
    healthController?.abort();
    healthController = null;
    healthEpoch += 1;
    health = null;
    healthPopoverOpen = false;
    renderHealth();
    if (!activeTheaterId) return;
    const requestEpoch = healthEpoch;
    const theaterId = activeTheaterId;
    const controller = new AbortController();
    healthController = controller;
    void fetchHealth(theaterId, controller.signal).then((result) => {
      if (controller.signal.aborted || requestEpoch !== healthEpoch || theaterId !== activeTheaterId) return;
      health = result;
      renderHealth();
    }).catch(() => {});
  }

  function renderList(state: AppState): void {
    const t = consoleT();
    root.querySelectorAll<HTMLElement>("[data-mode]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.mode === mode)));
    searchInput.hidden = mode === "schema";
    sortControls.hidden = mode === "schema";
    activeFilterButton.hidden = mode === "schema" || activeTag === null;
    if (mode === "schema") {
      const catalog = state.schemaCatalog;
      eyebrow.textContent = t("codex.nav.schemaCount", { count: catalog?.templates.length ?? 0 });
      navList.innerHTML = catalog ? `
        <button class="codex-nav-entry" type="button" ${catalog.schema.exists ? 'data-schema-resource="workspace"' : 'disabled aria-disabled="true"'}><span class="t">${escapeHtml(t("codex.nav.workspaceSchema"))}</span><span class="meta">${catalog.schema.exists ? escapeHtml(catalog.schema.ref) : escapeHtml(t("codex.nav.unavailable"))}</span></button>
        ${catalog.templates.map((template) => `<button class="codex-nav-entry" type="button" data-template-id="${escapeHtml(template.id)}"><span class="t">${escapeHtml(template.id)}</span><span class="meta">${escapeHtml(template.ref)}</span></button>`).join("")}` : `<div class="codex-nav-empty">${escapeHtml(t("codex.nav.schemaUnavailable"))}</div>`;
      drydockBadge.textContent = String(state.pendingPatchCount);
      return;
    }

    const localMatches = sortEntries(filterEntries(state.index, currentQuery, activeTag), sortOrder);
    const seenIds = new Set(localMatches.map((entry) => entry.id));
    const remoteMatches = sortEntries(
      serverResults.filter((entry) => {
        if (seenIds.has(entry.id) || (activeTag && !entry.tags.includes(activeTag))) return false;
        seenIds.add(entry.id);
        return true;
      }),
      sortOrder,
    );
    const merged = [
      ...localMatches.map((entry) => ({ entry, snippet: undefined })),
      ...remoteMatches.map((entry) => ({ entry, snippet: entry.excerpt })),
    ];

    eyebrow.textContent = t("codex.nav.entriesCount", { count: merged.length });
    if (activeTag) {
      activeFilterButton.hidden = false;
      activeFilterButton.textContent = `${activeTag} ×`;
      activeFilterButton.setAttribute("aria-label", t("codex.nav.clearTagFilter", { tag: activeTag }));
    }
    root.querySelectorAll<HTMLElement>("[data-sort]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.sort === sortOrder));
    });
    drydockBadge.textContent = String(state.pendingPatchCount);
    drydockBadge.hidden = state.pendingPatchCount === 0;

    if (state.loading && state.index.length === 0) {
      navList.innerHTML = `<div class="codex-nav-loading" aria-live="polite">${escapeHtml(t("common.loading"))}</div>`;
      return;
    }
    if (state.error) {
      navList.innerHTML = `<div class="codex-nav-error" role="alert">${escapeHtml(state.error)}</div>`;
      return;
    }
    if (merged.length === 0) {
      navList.innerHTML = `<div class="codex-nav-empty">${escapeHtml(currentQuery || activeTag ? t("codex.nav.noMatch") : t("codex.nav.noEntries"))}</div>`;
      return;
    }
    const renderRow = ({ entry, snippet }: { entry: WikiIndexEntry; snippet: string | undefined }) => renderEntry(entry, {
      activeTag,
      isCurrent: entry.id === currentEntryId,
      query: currentQuery,
      snippet,
    });
    // 검색·태그 필터·이름순에서는 평평한 목록이 정답이다 — 그룹은 "훑는" 기본 화면 전용.
    if (currentQuery || activeTag || sortOrder !== "updated") {
      navList.innerHTML = merged.map(renderRow).join("");
      return;
    }
    navList.innerHTML = renderGroupedEntries(merged, renderRow, t);
  }

  function requestServerSearch(): void {
    searchController?.abort();
    searchController = null;
    searchEpoch += 1;
    serverResults = [];
    renderList(getState());
    if (!currentQuery) return;

    const requestEpoch = searchEpoch;
    const theaterId = activeTheaterId;
    const query = currentQuery;
    const controller = new AbortController();
    searchController = controller;
    void fetchSearch(theaterId, {
      q: query,
      tags: activeTag ? [activeTag] : undefined,
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted || requestEpoch !== searchEpoch || theaterId !== activeTheaterId || query !== currentQuery) return;
      serverResults = result.entries;
      renderList(getState());
    }).catch(() => {
      // Remote search is an enhancement; local title/tag results remain usable.
    });
  }

  function selectEntry(id: string): void {
    currentEntryId = id;
    renderList(getState());
    options.onRequest({ kind: "entry", id });
  }

  function handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const healthDetail = target.closest<HTMLElement>("[data-health-detail]");
    if (healthDetail) {
      event.stopPropagation();
      healthPopoverOpen = !healthPopoverOpen;
      renderHealth();
      return;
    }

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

    const tagButton = target.closest<HTMLElement>("[data-tag]");
    if (tagButton?.dataset.tag) {
      event.stopPropagation();
      activeTag = activeTag === tagButton.dataset.tag ? null : tagButton.dataset.tag;
      requestServerSearch();
      return;
    }
    if (target.closest("[data-clear-tag]")) {
      activeTag = null;
      requestServerSearch();
      return;
    }

    const sortButton = target.closest<HTMLElement>("[data-sort]");
    if (sortButton?.dataset.sort === "updated" || sortButton?.dataset.sort === "name") {
      sortOrder = sortButton.dataset.sort;
      saveSortOrder(sortOrder);
      renderList(getState());
      return;
    }

    const entry = target.closest<HTMLElement>("[data-entry-id]");
    if (entry?.dataset.entryId) {
      selectEntry(entry.dataset.entryId);
      return;
    }

    const quickBtn = target.closest<HTMLElement>("[data-action]");
    if (quickBtn?.dataset.action === "drydock") {
      options.onRequest({ kind: "drydock" });
      return;
    }
    if (quickBtn?.dataset.action === "conflicts") {
      options.onRequest({ kind: "conflicts" });
    }
  }

  function handleDocumentClick(event: MouseEvent): void {
    if (!healthPopoverOpen || healthStrip.contains(event.target as Node)) return;
    healthPopoverOpen = false;
    renderHealth();
  }

  function handleDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !healthPopoverOpen) return;
    healthPopoverOpen = false;
    renderHealth();
    root.querySelector<HTMLButtonElement>("[data-health-detail]")?.focus();
  }

  function handleSearchInput(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    searchController?.abort();
    searchController = null;
    searchEpoch += 1;
    serverResults = [];
    renderList(getState());
    debounceTimer = setTimeout(() => {
      currentQuery = searchInput.value;
      requestServerSearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  root.addEventListener("click", handleClick);
  searchInput.addEventListener("input", handleSearchInput);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleDocumentKeyDown);

  const unsubscribe = subscribeState((state) => renderList(state));
  renderList(getState());
  loadHealth();

  return {
    destroy(): void {
      unsubscribe();
      root.removeEventListener("click", handleClick);
      searchInput.removeEventListener("input", handleSearchInput);
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleDocumentKeyDown);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      searchController?.abort();
      healthController?.abort();
      root.innerHTML = "";
    },
    setTheater(theaterId: string | null): void {
      activeTheaterId = theaterId;
      currentQuery = "";
      currentEntryId = null;
      activeTag = null;
      serverResults = [];
      searchEpoch += 1;
      searchController?.abort();
      searchController = null;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      searchInput.value = "";
      renderList(getState());
      loadHealth();
    },
    setCurrentEntry(entryId: string | null): void {
      if (currentEntryId === entryId) return;
      currentEntryId = entryId;
      renderList(getState());
    },
    setActiveTag(tag: string | null): void {
      // 광고된 액션은 "카탈로그를 이 태그로 거른다"이다 — 스키마 모드에 있어도 먼저
      // 항목 목록으로 복귀해야 같은 태그 재클릭이 무반응으로 보이지 않는다.
      mode = "entries";
      if (activeTag === tag) {
        renderList(getState());
        return;
      }
      activeTag = tag;
      requestServerSearch();
    },
    refreshHealth(): void {
      loadHealth();
    },
    refreshLocale(): void {
      const t = consoleT();
      root.querySelector(".codex-nav-modes")?.setAttribute("aria-label", t("codex.nav.catalogAria"));
      const entriesTab = root.querySelector<HTMLElement>('[data-mode="entries"]');
      if (entriesTab) entriesTab.textContent = t("codex.nav.entries");
      const schemaTab = root.querySelector<HTMLElement>('[data-mode="schema"]');
      if (schemaTab) schemaTab.textContent = t("codex.nav.schema");
      searchInput.placeholder = t("codex.nav.searchPlaceholder");
      searchInput.setAttribute("aria-label", t("codex.nav.searchAria"));
      const drydockBtn = root.querySelector<HTMLElement>('[data-action="drydock"]');
      if (drydockBtn) {
        drydockBtn.replaceChildren(
          document.createTextNode(`${t("codex.nav.reviewQueue")} `),
          drydockBadge,
        );
      }
      const conflictsBtn = root.querySelector<HTMLElement>('[data-action="conflicts"]');
      if (conflictsBtn) {
        conflictsBtn.replaceChildren(
          document.createTextNode(`${t("codex.nav.conflicts")} `),
          conflictBadge,
        );
      }
      renderHealth();
      sortControls.setAttribute("aria-label", t("codex.nav.sortAria"));
      const updatedSort = root.querySelector<HTMLElement>('[data-sort="updated"]');
      if (updatedSort) updatedSort.textContent = t("codex.nav.sortUpdated");
      const nameSort = root.querySelector<HTMLElement>('[data-sort="name"]');
      if (nameSort) nameSort.textContent = t("codex.nav.sortName");
      renderList(getState());
    },
  };
}
