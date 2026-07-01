import {
  decideDrydock,
  fetchConflictDetail,
  fetchConflicts,
  fetchDrydock,
  fetchDrydockDetail,
  fetchEntry,
} from "./api.js";
import type {
  ConflictDetailResponse,
  ConflictListItem,
  DrydockDetailResponse,
  DrydockListItem,
  DrydockMeta,
  EntryResponse,
} from "./api.js";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import { renderMarkdown } from "@fleet-console/markdown/core";
import { buildCompactContext, buildProvenanceContext, buildRelatedContextPack, renderCopyContextActions } from "./components/copy-context-actions.js";
import { renderMetaChips, renderTagChips } from "./components/meta-chips.js";
import { installTocScrollSpy, renderTocSheet } from "./components/toc-sheet.js";
import { getState } from "./state.js";
import { entryPath } from "./router.js";
import { escapeAttribute, escapeHtml } from "./utils/html.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReadingController {
  destroy(): void;
  setEntry(entryId: string): Promise<void>;
  navigateSub(subId: string | undefined): Promise<void>;
}

export interface MountReadingOptions {
  readonly initialEntryId: string;
  readonly kind: "entry" | "drydock" | "conflicts";
  readonly subId?: string;
  readonly theaterId: string | null;
  readonly onRelatedClick: (id: string) => void;
  readonly onClose: () => void;
  /** 패치 행 클릭(상세 진입) 또는 뒤로가기(undefined) 콜백 */
  readonly onPatchOpen?: (patchId: string | undefined) => void;
  /** 승인/반려 결정 완료 후 목록 갱신을 트리거하는 콜백 */
  readonly onDecided?: () => void;
  readonly tocContainer: HTMLElement;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OP_BADGE_GLYPHS: Record<string, string> = { create_wiki: "+", update_wiki: "↻" };
const OP_LABELS: Record<string, string> = { create_wiki: "Create", update_wiki: "Update" };

// ─── Public API ───────────────────────────────────────────────────────────────

export function mountReadingInto(
  readContainer: HTMLElement,
  opts: MountReadingOptions,
): ReadingController {
  let destroyed = false;
  let cleanupSpy: (() => void) | null = null;

  // 드라이독 결정 상태 (패치 상세 뷰에서 관리)
  type DecisionPhase = "idle" | "approving" | "rejecting" | "submitting";
  let decisionPhase: DecisionPhase = "idle";
  let decisionError: string | null = null;
  let currentDetailMeta: DrydockMeta | null = null;
  let currentDetailPatchId: string | null = null;

  installDiagramHydrator(readContainer);

  function handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // 패치 행 클릭 (목록 → 상세 또는 뒤로가기)
    const patchRowBtn = target.closest<HTMLElement>("[data-patch-id]");
    if (patchRowBtn) {
      event.preventDefault();
      const patchId = patchRowBtn.dataset.patchId || undefined;
      opts.onPatchOpen?.(patchId);
      return;
    }

    // Related 엔트리 클릭
    const relatedBtn = target.closest<HTMLElement>("[data-entry-id]");
    if (relatedBtn?.dataset.entryId) {
      event.preventDefault();
      opts.onRelatedClick(relatedBtn.dataset.entryId);
      return;
    }

    // 드라이독 결정/뒤로가기 액션
    const drydockBtn = target.closest<HTMLElement>("[data-drydock-action]");
    if (drydockBtn) {
      event.preventDefault();
      handleDrydockAction(drydockBtn.dataset.drydockAction);
      return;
    }

    // 복사 컨텍스트 액션 (엔트리 전용)
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

  function handleDrydockAction(action: string | undefined): void {
    if (!action) return;

    if (action === "back") {
      opts.onPatchOpen?.(undefined);
      return;
    }

    if (action === "approve") {
      decisionPhase = "approving";
      decisionError = null;
      redrawDecisionBar();
      return;
    }

    if (action === "approve-confirm") {
      void submitDecision("approve", undefined);
      return;
    }

    if (action === "reject") {
      decisionPhase = "rejecting";
      decisionError = null;
      redrawDecisionBar();
      return;
    }

    if (action === "reject-submit") {
      const reason = readContainer
        .querySelector<HTMLTextAreaElement>("#queue-reject-reason")
        ?.value.trim();
      if (!reason) {
        decisionError = "Rejection reason is required.";
        redrawDecisionBar();
        return;
      }
      void submitDecision("reject", reason);
      return;
    }

    if (action === "cancel") {
      decisionPhase = "idle";
      decisionError = null;
      redrawDecisionBar();
      return;
    }
  }

  async function submitDecision(
    action: "approve" | "reject",
    reason: string | undefined,
  ): Promise<void> {
    if (!currentDetailPatchId) return;
    decisionPhase = "submitting";
    decisionError = null;
    redrawDecisionBar();
    try {
      await decideDrydock(opts.theaterId, currentDetailPatchId, action, reason);
      opts.onDecided?.();
    } catch (err) {
      decisionPhase = action === "approve" ? "approving" : "rejecting";
      decisionError = err instanceof Error ? err.message : String(err);
      redrawDecisionBar();
    }
  }

  function redrawDecisionBar(): void {
    const wrap = readContainer.querySelector<HTMLElement>("[data-decision-bar-wrap]");
    if (!wrap) return;
    wrap.innerHTML = renderDecisionBarContent(decisionPhase, decisionError);
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
        resolveWikiLink: (id) => entryPath(id),
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
    cleanupReader();

    // 새 뷰 진입 시 결정 상태 초기화
    currentDetailMeta = null;
    currentDetailPatchId = null;
    decisionPhase = "idle";
    decisionError = null;

    try {
      if (patchId) {
        const detail = await fetchDrydockDetail(opts.theaterId, patchId);
        if (destroyed) return;

        currentDetailMeta = detail.meta;
        currentDetailPatchId = patchId;

        const { html: markdownHtml, toc } = renderMarkdown(detail.wikiEntry.body, {
          omitDuplicateTitle: detail.wikiEntry.title,
          resolveWikiLink: (id) => entryPath(id),
        });

        readContainer.innerHTML = renderPatchDetail(detail, markdownHtml);

        opts.tocContainer.innerHTML = renderTocSheet(toc);
        const article = readContainer.querySelector<HTMLElement>("article");
        if (article && toc.length > 0) {
          cleanupSpy = installTocScrollSpy(article, toc, opts.tocContainer);
        }
      } else {
        const list = await fetchDrydock(opts.theaterId, "pending");
        if (destroyed) return;
        opts.tocContainer.innerHTML = "";
        readContainer.innerHTML = renderDrydockList(list.items, "Drydock — Pending Patches");
      }
    } catch (error) {
      if (!destroyed) showError(readContainer, opts.tocContainer, error);
    }
  }

  async function renderConflictsView(conflictId: string | undefined): Promise<void> {
    if (destroyed) return;
    showLoading(readContainer, opts.tocContainer);
    cleanupReader();

    try {
      if (conflictId) {
        const detail = await fetchConflictDetail(opts.theaterId, conflictId);
        if (destroyed) return;
        opts.tocContainer.innerHTML = "";
        readContainer.innerHTML = renderConflictDetail(detail);
      } else {
        const conflicts = await fetchConflicts(opts.theaterId);
        if (destroyed) return;
        opts.tocContainer.innerHTML = "";
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
    async navigateSub(subId: string | undefined): Promise<void> {
      if (opts.kind === "drydock") {
        await renderDrydockView(subId);
      } else if (opts.kind === "conflicts") {
        await renderConflictsView(subId);
      }
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

function renderDrydockList(items: DrydockListItem[], title: string): string {
  if (items.length === 0) {
    return `<div class="codex-reader-empty"><p class="queue-empty">No pending patches.</p></div>`;
  }
  return `
    <article class="document">
      <header class="document-header">
        <nav class="breadcrumb" aria-label="Entry location">
          <ol>
            <li><span>Codex</span></li>
            <li><span aria-current="page">Drydock</span></li>
          </ol>
        </nav>
        <h1>${escapeHtml(title)}</h1>
      </header>
      <div class="queue-row-list">
        ${items.map(renderQueueRow).join("")}
      </div>
    </article>
  `;
}

function renderQueueRow(item: DrydockListItem): string {
  const op = item.op ?? "create_wiki";
  const glyph = OP_BADGE_GLYPHS[op] ?? "?";
  const opLabel = OP_LABELS[op] ?? "Patch";
  const target = item.target ?? item.id;
  const time = formatRelativeTime(item.meta.createdAt);
  const metaParts = [time].filter(Boolean);
  return `
    <button class="queue-row" type="button" data-patch-id="${escapeAttribute(item.id)}" aria-label="${escapeAttribute(opLabel + ": " + target)}">
      <span class="queue-row-badge" aria-hidden="true">
        <span class="op-badge">${glyph}</span>
      </span>
      <span class="queue-row-body">
        <span class="queue-row-target">${escapeHtml(target)}</span>
        ${item.summary ? `<span class="queue-row-summary">${escapeHtml(item.summary)}</span>` : ""}
        ${metaParts.length > 0 ? `<span class="queue-row-meta">${metaParts.map(escapeHtml).join(" · ")}</span>` : ""}
      </span>
    </button>
  `;
}

function renderPatchDetail(detail: DrydockDetailResponse, markdownHtml: string): string {
  const { patch, meta, wikiEntry, targetExists } = detail;
  const op = patch.frontmatter.op;
  const glyph = OP_BADGE_GLYPHS[op] ?? "?";
  const opLabel = OP_LABELS[op] ?? "Patch";
  const targetLabel = targetExists ? "기존 문서 대체" : "신규 문서 생성";
  const isPending = meta.status === "pending";

  return `
    <article class="document">
      <header class="document-header">
        <nav class="breadcrumb" aria-label="Entry location">
          <ol>
            <li><span>Codex</span></li>
            <li><span>Drydock</span></li>
            <li><span aria-current="page">${escapeHtml(opLabel)}</span></li>
          </ol>
        </nav>
        <button type="button" class="queue-back-btn" data-drydock-action="back">‹ Queue</button>
        <h1><span class="op-badge">${glyph}</span> ${escapeHtml(wikiEntry.title)}</h1>
        <p class="eyebrow">${escapeHtml(patch.frontmatter.target)} · v${wikiEntry.version} · ${escapeHtml(targetLabel)}</p>
        ${renderPatchMetaChips(patch.frontmatter.proposer, wikiEntry.tags)}
      </header>
      <div class="markdown-body" id="codex-reader-body">
        ${markdownHtml}
      </div>
      <div class="queue-decision-section" data-decision-bar-wrap>
        ${isPending
          ? renderDecisionBarContent("idle", null)
          : renderDecidedState(meta)}
      </div>
    </article>
  `;
}

function renderPatchMetaChips(proposer: string, tags: string[]): string {
  const parts: string[] = [];
  if (proposer) parts.push(`<span class="meta-chip">${escapeHtml(proposer)}</span>`);
  if (tags.length > 0) parts.push(renderTagChips(tags));
  if (parts.length === 0) return "";
  return `<div class="meta-chips">${parts.join("")}</div>`;
}

function renderDecisionBarContent(
  phase: "idle" | "approving" | "rejecting" | "submitting",
  error: string | null,
): string {
  if (phase === "submitting") {
    return `<span class="queue-action-spinner" role="status" aria-label="Processing…"></span>`;
  }
  if (phase === "approving") {
    return `
      <p class="queue-decision-confirm">Apply this patch to the wiki?</p>
      <div class="queue-action-buttons">
        <button type="button" class="queue-action-btn queue-action-btn--approve" data-drydock-action="approve-confirm">✓ Yes, Approve</button>
        <button type="button" class="queue-action-btn queue-action-btn--cancel" data-drydock-action="cancel">Cancel</button>
      </div>
      ${error ? `<p class="queue-action-error">${escapeHtml(error)}</p>` : ""}
    `;
  }
  if (phase === "rejecting") {
    return `
      <div class="queue-reject-form">
        <textarea class="queue-reject-textarea" id="queue-reject-reason" placeholder="Rejection reason (required)…" rows="3"></textarea>
        <div class="queue-action-buttons">
          <button type="button" class="queue-action-btn queue-action-btn--reject-submit" data-drydock-action="reject-submit">Submit Rejection</button>
          <button type="button" class="queue-action-btn queue-action-btn--cancel" data-drydock-action="cancel">Cancel</button>
        </div>
        ${error ? `<p class="queue-action-error">${escapeHtml(error)}</p>` : ""}
      </div>
    `;
  }
  // idle
  return `
    <div class="queue-action-buttons">
      <button type="button" class="queue-action-btn queue-action-btn--approve" data-drydock-action="approve">✓ Approve</button>
      <button type="button" class="queue-action-btn queue-action-btn--reject" data-drydock-action="reject">✕ Reject</button>
    </div>
  `;
}

function renderDecidedState(meta: DrydockMeta): string {
  const isAccepted = meta.status === "accepted";
  const label = isAccepted ? "✓ Approved" : "✕ Rejected";
  const cls = isAccepted ? "queue-decision-decided--approve" : "queue-decision-decided--reject";
  const reason = meta.reason ? ` · ${escapeHtml(meta.reason)}` : "";
  return `<p class="queue-decision-decided ${cls}">${label}${reason}</p>`;
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

function formatRelativeTime(isoString: string): string {
  try {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    if (diffHours < 1) return "< 1h ago";
    if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
    const diffDays = diffHours / 24;
    if (diffDays < 7) return `${Math.floor(diffDays)}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
    return `${Math.floor(diffDays / 30)}mo ago`;
  } catch {
    return "";
  }
}
