import { getGlobalSettingsStoreState } from "../../global-settings-store.js";
import { getT } from "../../i18n/index.js";
import { resolveConsoleLanguage } from "../../whatsnew-i18n.js";
import { askWiki, createEntry, fetchHealth, fetchSearch, fetchSchemaDocument, runDrydock } from "../api.js";
import type { QueryAnswerResponse } from "../api.js";
import { getState, loadInitialData, subscribeState } from "../state.js";
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

function formatRelativeUpdated(iso: string): string {
  const updated = new Date(iso);
  if (Number.isNaN(updated.getTime())) return iso;
  const now = new Date();
  const updatedDay = Date.UTC(updated.getFullYear(), updated.getMonth(), updated.getDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const t = consoleT();
  const elapsedDays = Math.max(0, Math.floor((today - updatedDay) / 86_400_000));
  if (elapsedDays === 0) return t("codex.nav.updatedToday");
  if (elapsedDays < 30) return t("codex.nav.updatedDaysAgo", { count: elapsedDays });
  if (elapsedDays < 365) return t("codex.nav.updatedMonthsAgo", { count: Math.floor(elapsedDays / 30) });
  return t("codex.nav.updatedYearsAgo", { count: Math.floor(elapsedDays / 365) });
}

function renderEntry(entry: WikiIndexEntry, options: RenderEntryOptions): string {
  const tagMatches = options.query
    ? entry.tags.some((tag) => tag.toLowerCase().includes(options.query.toLowerCase()))
    : false;
  const tags = entry.tags
    .slice(0, 3)
    .map((tag) => renderTagChip(tag, tag === options.activeTag))
    .join("");
  const kind = escapeHtml(entry.status ?? "current");
  const updated = entry.updated ?? "";

  return `<div
    class="codex-nav-entry${options.isCurrent ? " is-current" : ""}"
    data-entry-id="${escapeHtml(entry.id)}"
    tabindex="-1"
    ${options.isCurrent ? 'aria-current="page"' : ""}
  >
    <button class="t" type="button" title="${escapeHtml(entry.title)}">${highlightMatch(entry.title, tagMatches ? "" : options.query)}</button>
    ${tags ? `<span class="tg">${tags}</span>` : ""}
    ${options.snippet ? `<span class="snippet">${highlightMatch(options.snippet, options.query)}</span>` : ""}
    <span class="meta" title="${escapeHtml(updated)}">${kind} · ${escapeHtml(formatRelativeUpdated(updated))}</span>
  </div>`;
}

function filterEntries(
  entries: WikiIndexEntry[],
  query: string,
  activeTag: string | null,
  facet: { axis: "type" | "status"; value: string } | null,
): WikiIndexEntry[] {
  const q = query.toLowerCase();
  return entries.filter((entry) => {
    const matchesQuery = !query ||
      entry.title.toLowerCase().includes(q) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(q));
    if (!matchesQuery) return false;
    if (activeTag && !entry.tags.includes(activeTag)) return false;
    if (!facet) return true;
    // status가 비어 있는 문서는 fleet-wiki 기본값과 같이 current로 센다.
    const value = facet.axis === "type" ? entry.type : (entry.status ?? "current");
    return value === facet.value;
  });
}

/** 실제 말뭉치에 존재하는 값만 패싯으로 낸다 — 비어 있는 칸은 선택지가 아니다. */
function buildFacets(entries: WikiIndexEntry[]): Array<{ axis: "type" | "status"; value: string; count: number }> {
  const counts = new Map<string, { axis: "type" | "status"; value: string; count: number }>();
  const bump = (axis: "type" | "status", value: string | undefined) => {
    if (!value) return;
    const key = `${axis}:${value}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { axis, value, count: 1 });
  };
  for (const entry of entries) {
    bump("type", entry.type);
    bump("status", entry.status ?? "current");
  }
  return [...counts.values()].sort((left, right) =>
    left.axis.localeCompare(right.axis) || right.count - left.count || left.value.localeCompare(right.value));
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
  let mode: "entries" | "schema" | "ask" = "entries";
  // 패싯은 fleet-wiki가 이미 정의해 둔 type·status enum이고, UI가 한 번도 보여준 적이 없다.
  let activeFacet: { axis: "type" | "status"; value: string } | null = null;
  let lastCheck: string | null = null;
  // Ask 모드 상태 — 검색과 달리 한 번의 명시적 제출로만 돌아간다.
  let askAnswer: QueryAnswerResponse | null = null;
  let askState: "idle" | "loading" | "error" = "idle";
  let askError: string | null = null;
  let askEpoch = 0;
  let askQuestion = "";
  let creating = false;
  let createError: string | null = null;
  // 네이티브 select는 제품 표면에서 금지된다 — 패싯과 같은 칩 문법을 쓴다.
  let createTemplate = "";
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let searchController: AbortController | null = null;
  let healthController: AbortController | null = null;
  let searchEpoch = 0;
  let healthEpoch = 0;
  let health: CodexHealthResponse | null = null;
  let healthPopoverOpen = false;

  /** 패싯 줄. 활성 패싯만 brass(위치 채널)를 쓴다. */
  function renderFacets(entries: WikiIndexEntry[]): void {
    const host = root.querySelector<HTMLElement>("#codex-nav-facets");
    if (!host) return;
    if (mode !== "entries") { host.innerHTML = ""; host.hidden = true; return; }
    const facets = buildFacets(entries);
    if (facets.length === 0) { host.innerHTML = ""; host.hidden = true; return; }
    host.hidden = false;
    const t = consoleT();
    const all = `<button type="button" class="codex-facet${activeFacet ? "" : " is-active"}" data-facet-clear aria-pressed="${!activeFacet}">${escapeHtml(t("codex.nav.facetAll"))} <span class="c">${entries.length}</span></button>`;
    host.innerHTML = all + facets.map((facet) => {
      const active = activeFacet?.axis === facet.axis && activeFacet.value === facet.value;
      return `<button type="button" class="codex-facet${active ? " is-active" : ""}" data-facet-axis="${escapeHtml(facet.axis)}" data-facet-value="${escapeHtml(facet.value)}" aria-pressed="${active}">${escapeHtml(facet.value)} <span class="c">${facet.count}</span></button>`;
    }).join("");
  }

  /**
   * 말뭉치에 묻는 화면. 답을 지어내지 않는다 — `wiki_resolve`가 고른 항목과 그 항목이
   * 내세우는 근거·출처를 그대로 보여주고, 클릭하면 원문으로 간다. 답변 생성은 여기서
   * 하지 않으므로 출처 없는 문장이 화면에 생길 수 없다.
   */
  function renderAskPanel(): string {
    const t = consoleT();
    const form = `
      <form class="codex-ask-form" data-ask-form>
        <input class="codex-ask-input" name="q" type="search" autocomplete="off" spellcheck="false"
          placeholder="${escapeHtml(t("codex.nav.askPlaceholder"))}"
          aria-label="${escapeHtml(t("codex.nav.ask"))}" value="${escapeHtml(askQuestion)}" />
      </form>`;
    if (askState === "loading") return `${form}<div class="codex-nav-loading" aria-live="polite">${escapeHtml(t("codex.query.answering"))}</div>`;
    if (askState === "error") return `${form}<div class="codex-nav-error" role="alert">${escapeHtml(askError ?? "")}</div>`;
    if (!askAnswer) return form;
    if (askAnswer.entries.length === 0) return `${form}<div class="codex-nav-empty">${escapeHtml(t("codex.query.noAnswer"))}</div>`;

    const uncertain = askAnswer.missingOrUncertain.length > 0
      ? `<div class="codex-ask-uncertain"><b>${escapeHtml(t("codex.query.uncertain"))}</b><ul>${askAnswer.missingOrUncertain.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
      : "";

    const cards = askAnswer.entries.map((entry) => `
      <article class="codex-ask-card">
        <button class="codex-ask-card-title" type="button" data-entry-id="${escapeHtml(entry.id)}">${escapeHtml(entry.title)}</button>
        <p class="codex-ask-summary">${escapeHtml(entry.summary)}</p>
        ${entry.facts.length > 0 ? `<ul class="codex-ask-facts">${entry.facts.map((fact) => `
          <li>
            <span class="codex-ask-claim">${escapeHtml(fact.claim)}</span>
            ${fact.sourceRefs.length > 0 ? `<span class="codex-ask-source">${escapeHtml(t("codex.query.sources"))}: ${escapeHtml(fact.sourceRefs.join(", "))}</span>` : ""}
          </li>`).join("")}</ul>` : ""}
        <p class="codex-ask-meta">${escapeHtml(entry.status)} &middot; ${escapeHtml(formatRelativeUpdated(entry.updated))}</p>
      </article>`).join("");

    return `${form}${uncertain}<div class="codex-ask-results">${cards}</div>`;
  }

  async function submitAsk(question: string): Promise<void> {
    const trimmed = question.trim();
    askQuestion = trimmed;
    if (!trimmed) { askAnswer = null; askState = "idle"; renderList(getState()); return; }
    const epoch = ++askEpoch;
    const theaterId = activeTheaterId;
    askState = "loading";
    askError = null;
    renderList(getState());
    try {
      const answer = await askWiki(theaterId, trimmed);
      if (epoch !== askEpoch || theaterId !== activeTheaterId) return;
      askAnswer = answer;
      askState = "idle";
    } catch (error) {
      if (epoch !== askEpoch || theaterId !== activeTheaterId) return;
      askState = "error";
      askError = error instanceof Error ? error.message : String(error);
    }
    renderList(getState());
  }

  /** 신규 항목 폼. 템플릿을 고르면 그 본문이 초안이 된다. */
  function renderCreateForm(state: AppState): void {
    const host = root.querySelector<HTMLElement>("#codex-nav-create");
    if (!host) return;
    if (!creating || mode !== "entries") { host.innerHTML = ""; host.hidden = true; return; }
    host.hidden = false;
    const t = consoleT();
    const templates = state.schemaCatalog?.templates ?? [];
    host.innerHTML = `
      <form class="codex-create-form" data-create-form>
        <input class="codex-create-input" name="title" required autocomplete="off"
          placeholder="${escapeHtml(t("codex.nav.newTitle"))}" aria-label="${escapeHtml(t("codex.nav.newTitle"))}" />
        <input class="codex-create-input" name="id" required autocomplete="off" spellcheck="false"
          placeholder="${escapeHtml(t("codex.nav.newId"))}" aria-label="${escapeHtml(t("codex.nav.newId"))}" />
        ${templates.length > 0 ? `<div class="codex-create-templates" role="group" aria-label="${escapeHtml(t("codex.nav.newTemplate"))}">
          <button type="button" class="codex-facet${createTemplate ? "" : " is-active"}" data-template-pick="" aria-pressed="${!createTemplate}">${escapeHtml(t("codex.nav.newBlank"))}</button>
          ${templates.map((tpl) => `<button type="button" class="codex-facet${createTemplate === tpl.id ? " is-active" : ""}" data-template-pick="${escapeHtml(tpl.id)}" aria-pressed="${createTemplate === tpl.id}">${escapeHtml(tpl.id)}</button>`).join("")}
        </div>` : ""}
        <div class="codex-create-actions">
          <button type="submit" class="queue-action-btn queue-action-btn--approve">${escapeHtml(t("codex.nav.newCreate"))}</button>
          <button type="button" class="queue-action-btn queue-action-btn--cancel" data-action="new-cancel">${escapeHtml(t("common.cancel"))}</button>
        </div>
        ${createError ? `<p class="queue-action-error">${escapeHtml(createError)}</p>` : ""}
      </form>`;
    host.querySelector<HTMLInputElement>('[name="title"]')?.focus();
  }

  async function submitCreate(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form);
    const title = (data.get("title") ?? "").toString().trim();
    const id = (data.get("id") ?? "").toString().trim();
    const templateId = createTemplate;
    if (!title || !id) return;
    createError = null;
    let body = "";
    if (templateId) {
      // 템플릿 본문을 그대로 초안으로 쓴다 — 빈 문서보다 섹션이 있는 편이 쓰기 쉽다.
      try { body = (await fetchSchemaDocument(activeTheaterId, templateId)).content; } catch { body = ""; }
    }
    try {
      await createEntry(activeTheaterId, { id, title, body, ...(templateId ? { templateId } : {}) });
      creating = false;
      await loadInitialData();
      selectEntry(id);
    } catch (error) {
      createError = error instanceof Error ? error.message : String(error);
      renderList(getState());
    }
  }

  function renderShell(): void {
    const t = consoleT();
    root.innerHTML = `
    <div class="codex-navigator">
      <div class="codex-nav-modes" role="tablist" aria-label="${escapeHtml(t("codex.nav.catalogAria"))}">
        <button type="button" role="tab" data-mode="entries" aria-selected="true">${escapeHtml(t("codex.nav.entries"))}</button>
        <button type="button" role="tab" data-mode="schema" aria-selected="false">${escapeHtml(t("codex.nav.schema"))}</button>
        <button type="button" role="tab" data-mode="ask" aria-selected="false">${escapeHtml(t("codex.nav.ask"))}</button>
        <button type="button" class="codex-nav-new" data-action="new-entry" aria-label="${escapeHtml(t("codex.nav.newEntry"))}" title="${escapeHtml(t("codex.nav.newEntry"))}">+</button>
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
        <button class="codex-nav-quick" data-action="conflicts" type="button">${escapeHtml(t("codex.nav.conflicts"))}</button>
        <button class="codex-nav-quick" data-action="run-check" type="button">${escapeHtml(t("codex.nav.runCheck"))}</button>
      </div>
      <div class="codex-nav-create" id="codex-nav-create" hidden></div>
      <div class="codex-nav-facets" id="codex-nav-facets" role="group" aria-label="${escapeHtml(t("codex.nav.facetType"))}"></div>
      <div class="codex-nav-health" hidden></div>
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
  // 입력만 숨기면 아이콘이 남은 빈 줄이 보인다 — 검색 줄 전체를 숨긴다.
  const searchRow = root.querySelector<HTMLElement>(".codex-nav-search")!;
  const navList = root.querySelector<HTMLElement>("#codex-nav-list")!;
  const eyebrow = root.querySelector<HTMLElement>("#codex-nav-eyebrow")!;
  const drydockBadge = root.querySelector<HTMLElement>("#codex-nav-drydock-badge")!;
  const activeFilterButton = root.querySelector<HTMLButtonElement>("[data-clear-tag]")!;
  const sortControls = root.querySelector<HTMLElement>(".codex-nav-sort")!;
  const healthStrip = root.querySelector<HTMLElement>(".codex-nav-health")!;

  function renderHealth(): void {
    const t = consoleT();
    const drydock = health?.lastDrydock ?? null;
    const conflictCount = health?.conflictCount ?? 0;
    const pendingCount = health?.pendingCount ?? 0;
    const issueCount = drydock?.issueCount ?? 0;
    const logUnreadable = health?.logUnreadable === true;
    const visible = lastCheck !== null
      || (health !== null && (logUnreadable || !((drydock === null || (drydock.ok && issueCount === 0)) && conflictCount === 0 && pendingCount === 0)));
    healthStrip.hidden = !visible;
    if (!visible) {
      healthStrip.innerHTML = "";
      return;
    }
    if (!health) {
      healthStrip.innerHTML = `<span class="codex-nav-health-summary">${escapeHtml(lastCheck ?? "")}</span>`;
      return;
    }
    const tone = (drydock?.errorCount ?? 0) > 0 ? "coral" : "warn";
    const timestamp = drydock ? new Date(drydock.at).toLocaleString(resolveActiveLocale()) : t("codex.nav.healthNever");
    healthStrip.innerHTML = `
      <span class="codex-nav-health-dot is-${tone}" aria-hidden="true"></span>
      <span class="codex-nav-health-summary">${escapeHtml(lastCheck ?? (logUnreadable ? t("codex.nav.healthLogUnreadable") : t("codex.nav.healthSummary", { issues: issueCount, conflicts: health.conflictCount, pending: health.pendingCount })))}</span>
      <button class="codex-nav-health-detail" data-health-detail type="button" aria-expanded="${String(healthPopoverOpen)}">${escapeHtml(t("codex.nav.healthDetails"))}</button>
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
    searchRow.hidden = mode !== "entries";
    sortControls.hidden = mode !== "entries";
    activeFilterButton.hidden = mode !== "entries" || activeTag === null;
    if (mode === "ask") {
      renderFacets(state.index);
      eyebrow.textContent = t("codex.nav.ask");
      navList.innerHTML = renderAskPanel();
      drydockBadge.textContent = String(state.pendingPatchCount);
      return;
    }
    if (mode === "schema") {
      const catalog = state.schemaCatalog;
      eyebrow.textContent = t("codex.nav.schemaCount", { count: catalog?.templates.length ?? 0 });
      navList.innerHTML = catalog ? `
        <button class="codex-nav-entry" type="button" ${catalog.schema.exists ? 'data-schema-resource="workspace"' : 'disabled aria-disabled="true"'}><span class="t">${escapeHtml(t("codex.nav.workspaceSchema"))}</span><span class="meta">${catalog.schema.exists ? escapeHtml(catalog.schema.ref) : escapeHtml(t("codex.nav.unavailable"))}</span></button>
        ${catalog.templates.map((template) => `<button class="codex-nav-entry" type="button" data-template-id="${escapeHtml(template.id)}"><span class="t">${escapeHtml(template.id)}</span><span class="meta">${escapeHtml(template.ref)}</span></button>`).join("")}` : `<div class="codex-nav-empty">${escapeHtml(t("codex.nav.schemaUnavailable"))}</div>`;
      drydockBadge.textContent = String(state.pendingPatchCount);
      return;
    }

    const localMatches = sortEntries(filterEntries(state.index, currentQuery, activeTag, activeFacet), sortOrder);
    renderFacets(state.index);
    renderCreateForm(state);
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
    navList.innerHTML = merged
      .map(({ entry, snippet }) => renderEntry(entry, {
        activeTag,
        isCurrent: entry.id === currentEntryId,
        query: currentQuery,
        snippet,
      }))
      .join("");
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
    if (modeBtn?.dataset.mode === "entries" || modeBtn?.dataset.mode === "schema" || modeBtn?.dataset.mode === "ask") {
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

    if (target.closest("[data-facet-clear]")) {
      activeFacet = null;
      renderList(getState());
      return;
    }
    const facetBtn = target.closest<HTMLElement>("[data-facet-axis]");
    if (facetBtn) {
      const axis = facetBtn.dataset.facetAxis === "status" ? "status" : "type";
      const value = facetBtn.dataset.facetValue ?? "";
      // 같은 패싯을 다시 누르면 해제 — 토글이지 라디오가 아니다.
      activeFacet = activeFacet?.axis === axis && activeFacet.value === value ? null : { axis, value };
      renderList(getState());
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
    if (quickBtn?.dataset.action === "run-check") {
      void executeDrydockRun(quickBtn);
      return;
    }
    const templatePick = target.closest<HTMLElement>("[data-template-pick]");
    if (templatePick) {
      createTemplate = templatePick.dataset.templatePick ?? "";
      renderList(getState());
      return;
    }

    if (quickBtn?.dataset.action === "new-entry") {
      creating = !creating;
      createError = null;
      createTemplate = "";
      mode = "entries";
      renderList(getState());
      return;
    }
    if (quickBtn?.dataset.action === "new-cancel") {
      creating = false;
      createError = null;
      renderList(getState());
    }
  }

  /**
   * Drydock을 실제로 돌린다. 결과는 헬스 스트립에 그대로 흘려보낸다 — 검사 버튼이 자기
   * 결과창을 따로 만들면 같은 정보를 두 곳에서 말하게 된다.
   */
  async function executeDrydockRun(button: HTMLElement): Promise<void> {
    if (button.getAttribute("aria-busy") === "true") return;
    const t = consoleT();
    const original = button.textContent;
    button.setAttribute("aria-busy", "true");
    button.textContent = t("codex.nav.checkRunning");
    try {
      const report = await runDrydock(activeTheaterId);
      lastCheck = report.issues.length === 0
        ? t("codex.nav.checkClean")
        : t("codex.nav.checkResult", {
            errors: report.errorCount, warnings: report.warningCount, infos: report.infoCount,
          });
      loadHealth();
    } catch (error) {
      lastCheck = error instanceof Error ? error.message : String(error);
    } finally {
      button.removeAttribute("aria-busy");
      button.textContent = original;
      renderHealth();
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

  // Ask는 타이핑마다 돌면 안 된다 — 제출로만 실행한다.
  function handleSubmit(event: SubmitEvent): void {
    const host = event.target as HTMLElement | null;
    const createForm = host?.closest<HTMLFormElement>("[data-create-form]");
    if (createForm) { event.preventDefault(); void submitCreate(createForm); return; }
    const form = host?.closest<HTMLFormElement>("[data-ask-form]");
    if (!form) return;
    event.preventDefault();
    void submitAsk(new FormData(form).get("q")?.toString() ?? "");
  }

  root.addEventListener("submit", handleSubmit);
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
      root.removeEventListener("submit", handleSubmit);
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
      if (conflictsBtn) conflictsBtn.textContent = t("codex.nav.conflicts");
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
