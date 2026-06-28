import {
  fetchConflictDetail,
  fetchConflicts,
  fetchDrydock,
  fetchDrydockDetail,
  fetchEntry,
} from "./api.js";
import type { ConflictDetailResponse, ConflictListItem, DrydockDetailResponse, DrydockListItem, EntryResponse } from "./api.js";
import { installDiagramHydrator } from "./markdown/diagrams.js";
import { renderMarkdown } from "./markdown/renderer.js";
import type { TocItem } from "./markdown/renderer.js";
import { buildCompactContext, buildProvenanceContext, buildRelatedContextPack, renderCopyContextActions } from "./components/copy-context-actions.js";
import { renderMetaChips, renderTagChips } from "./components/meta-chips.js";
import { installTocScrollSpy, renderTocSheet } from "./components/toc-sheet.js";
import { getState } from "./state.js";
import { escapeAttribute, escapeHtml } from "./utils/html.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReadingController {
  destroy(): void;
  setEntry(entryId: string): Promise<void>;
}

export interface MountReadingOptions {
  readonly initialEntryId: string;
  readonly kind: "entry" | "drydock" | "conflicts";
  readonly subId?: string;
  readonly theaterId: string | null;
  readonly onRelatedClick: (id: string) => void;
  readonly onClose: () => void;
  readonly tocContainer: HTMLElement;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OP_BADGE_GLYPHS: Record<string, string> = { create_wiki: "+", update_wiki: "↻" };

// ─── Public API ───────────────────────────────────────────────────────────────

export function mountReadingInto(
  readContainer: HTMLElement,
  opts: MountReadingOptions,
): ReadingController {
  let destroyed = false;
  let cleanupSpy: (() => void) | null = null;

  installDiagramHydrator(readContainer);

  function handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const relatedBtn = target.closest<HTMLElement>("[data-entry-id]");
    if (relatedBtn?.dataset.entryId) {
      event.preventDefault();
      opts.onRelatedClick(relatedBtn.dataset.entryId);
      return;
    }

    const actionBtn = target.closest<HTMLElement>("[data-action]");
    if (!actionBtn) return;
    const action = actionBtn.dataset.action;
    const entry = (readContainer as HTMLElement & { _currentEntry?: EntryResponse })._currentEntry;
    if (!entry) return;

    if (action === "copy-compact-context") {
      void navigator.clipboard.writeText(buildCompactContext(entry));
    } else if (action === "copy-provenance-context") {
      void navigator.clipboard.writeText(buildProvenanceContext(entry));
    } else if (action === "copy-related-context") {
      void navigator.clipboard.writeText(buildRelatedContextPack(entry, getState().index));
    } else if (action === "toggle-why-matched") {
      const whyEl = actionBtn.nextElementSibling as HTMLElement | null;
      if (whyEl?.classList.contains("context-why-matched")) {
        whyEl.hidden = !whyEl.hidden;
      }
    }
  }

  readContainer.addEventListener("click", handleClick);

  function cleanupReader(): void {
    cleanupSpy?.();
    cleanupSpy = null;
  }

  async function renderEntryView(entryId: string): Promise<void> {
    if (destroyed) return;
    showLoading(readContainer, opts.tocContainer);
    cleanupReader();

    try {
      const entry = await fetchEntry(opts.theaterId, entryId);
      if (destroyed) return;

      const { index } = getState();
      const { html: markdownHtml, toc } = renderMarkdown(entry.body, {
        omitDuplicateTitle: entry.frontmatter.title,
      });

      (readContainer as HTMLElement & { _currentEntry?: EntryResponse })._currentEntry = entry;

      readContainer.innerHTML = `
        <article class="document">
          <header class="document-header">
            ${renderSheetBreadcrumb(entry.frontmatter.title)}
            <h1>${escapeHtml(entry.frontmatter.title)}</h1>
            ${renderMetaChips(entry.frontmatter)}
          </header>
          <div class="markdown-body" id="codex-reader-body">
            ${markdownHtml}
          </div>
          ${renderRelatedList(entry.frontmatter.id, entry.frontmatter.tags, index)}
          ${renderCopyContextActions(entry, index)}
        </article>
      `;

      opts.tocContainer.innerHTML = renderTocSheet(toc);
      const article = readContainer.querySelector<HTMLElement>("article");
      if (article && toc.length > 0) {
        cleanupSpy = installTocScrollSpy(article, toc, opts.tocContainer);
      }
    } catch (error) {
      if (!destroyed) showError(readContainer, opts.tocContainer, error);
    }
  }

  async function renderDrydockView(patchId: string | undefined): Promise<void> {
    if (destroyed) return;
    showLoading(readContainer, opts.tocContainer);
    opts.tocContainer.innerHTML = "";

    try {
      if (patchId) {
        const detail = await fetchDrydockDetail(opts.theaterId, patchId);
        if (destroyed) return;
        readContainer.innerHTML = renderPatchDetail(detail);
      } else {
        const list = await fetchDrydock(opts.theaterId, "pending");
        if (destroyed) return;
        readContainer.innerHTML = renderDrydockList(list.items, "Drydock — Pending Patches");
      }
    } catch (error) {
      if (!destroyed) showError(readContainer, opts.tocContainer, error);
    }
  }

  async function renderConflictsView(conflictId: string | undefined): Promise<void> {
    if (destroyed) return;
    showLoading(readContainer, opts.tocContainer);
    opts.tocContainer.innerHTML = "";

    try {
      if (conflictId) {
        const detail = await fetchConflictDetail(opts.theaterId, conflictId);
        if (destroyed) return;
        readContainer.innerHTML = renderConflictDetail(detail);
      } else {
        const conflicts = await fetchConflicts(opts.theaterId);
        if (destroyed) return;
        readContainer.innerHTML = renderConflictList(conflicts);
      }
    } catch (error) {
      if (!destroyed) showError(readContainer, opts.tocContainer, error);
    }
  }

  if (opts.kind === "entry" && opts.initialEntryId) {
    void renderEntryView(opts.initialEntryId);
  } else if (opts.kind === "drydock") {
    void renderDrydockView(opts.subId);
  } else if (opts.kind === "conflicts") {
    void renderConflictsView(opts.subId);
  }

  return {
    destroy(): void {
      destroyed = true;
      readContainer.removeEventListener("click", handleClick);
      cleanupReader();
    },
    async setEntry(entryId: string): Promise<void> {
      await renderEntryView(entryId);
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function showLoading(readContainer: HTMLElement, tocContainer: HTMLElement): void {
  readContainer.innerHTML = '<div class="codex-reader-loading" aria-live="polite" aria-busy="true">Loading…</div>';
  tocContainer.innerHTML = "";
}

function showError(readContainer: HTMLElement, tocContainer: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  readContainer.innerHTML = `<div class="codex-reader-error" role="alert">${escapeHtml(message)}</div>`;
  tocContainer.innerHTML = "";
}

function renderSheetBreadcrumb(title: string): string {
  return `
    <nav class="breadcrumb" aria-label="Entry location">
      <ol>
        <li><span>Codex</span></li>
        <li><span aria-current="page">${escapeHtml(title)}</span></li>
      </ol>
    </nav>
  `;
}

function renderRelatedList(currentId: string, currentTags: string[], entries: ReturnType<typeof getState>["index"]): string {
  const tagSet = new Set(currentTags);
  const related = entries
    .filter((e) => e.id !== currentId)
    .map((e) => ({ entry: e, matchingTags: e.tags.filter((t) => tagSet.has(t)) }))
    .filter((item) => item.matchingTags.length > 0)
    .sort(
      (a, b) =>
        b.matchingTags.length - a.matchingTags.length ||
        a.entry.title.localeCompare(b.entry.title, "en-US", { sensitivity: "base", numeric: true }),
    )
    .slice(0, 5);

  if (related.length === 0) return "";
  return `
    <section class="related-list">
      <h2>Related entries</h2>
      <div class="related-items">
        ${related
          .map(
            (item) =>
              `<button class="related-card" type="button" data-entry-id="${escapeAttribute(item.entry.id)}">
                <strong>${escapeHtml(item.entry.title)}</strong>
                <span>${renderTagChips(item.matchingTags)}</span>
              </button>`,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderPatchDetail(detail: DrydockDetailResponse): string {
  const op = detail.patch.frontmatter.op;
  const glyph = OP_BADGE_GLYPHS[op] ?? "?";
  return `
    <article class="document">
      <header class="document-header">
        <nav class="breadcrumb" aria-label="Entry location">
          <ol><li><span>Codex</span></li><li><span>Drydock</span></li></ol>
        </nav>
        <h1><span class="op-badge">${glyph}</span> ${escapeHtml(detail.patch.frontmatter.target)}</h1>
        <p class="eyebrow">${escapeHtml(detail.meta.status)}</p>
      </header>
      <div class="markdown-body">
        <pre><code>${escapeHtml(detail.patch.body)}</code></pre>
      </div>
    </article>
  `;
}

function renderDrydockList(items: DrydockListItem[], title: string): string {
  if (items.length === 0) {
    return `<div class="codex-reader-empty"><p>No pending patches.</p></div>`;
  }
  return `
    <article class="document">
      <header class="document-header">
        <h1>${escapeHtml(title)}</h1>
      </header>
      <div class="markdown-body">
        <ul class="queue-list">
          ${items
            .map(
              (item) =>
                `<li class="queue-item">
                  <span class="op-badge">${escapeHtml(OP_BADGE_GLYPHS[item.op ?? ""] ?? "?")}</span>
                  <strong>${escapeHtml(item.target ?? item.id)}</strong>
                  ${item.summary ? `<span class="queue-summary">${escapeHtml(item.summary)}</span>` : ""}
                </li>`,
            )
            .join("")}
        </ul>
      </div>
    </article>
  `;
}

function renderConflictDetail(detail: ConflictDetailResponse): string {
  return `
    <article class="document">
      <header class="document-header">
        <nav class="breadcrumb" aria-label="Entry location">
          <ol><li><span>Codex</span></li><li><span>Conflicts</span></li></ol>
        </nav>
        <h1>${escapeHtml(detail.id)}</h1>
        <p class="eyebrow">Conflict · ${escapeHtml(detail.meta?.status as string ?? "open")}</p>
      </header>
      <div class="markdown-body">
        ${detail.current ? `<h2>Current</h2><pre><code>${escapeHtml(detail.current)}</code></pre>` : ""}
        ${detail.proposed ? `<h2>Proposed</h2><pre><code>${escapeHtml(detail.proposed)}</code></pre>` : ""}
      </div>
    </article>
  `;
}

function renderConflictList(conflicts: ConflictListItem[]): string {
  if (conflicts.length === 0) {
    return `<div class="codex-reader-empty"><p>No conflicts found.</p></div>`;
  }
  return `
    <article class="document">
      <header class="document-header">
        <h1>Conflicts</h1>
      </header>
      <div class="markdown-body">
        <ul class="queue-list">
          ${conflicts
            .map(
              (item) =>
                `<li class="queue-item">
                  <strong>${escapeHtml(item.title || item.id)}</strong>
                  <span class="eyebrow">${escapeHtml(item.status)}</span>
                </li>`,
            )
            .join("")}
        </ul>
      </div>
    </article>
  `;
}
