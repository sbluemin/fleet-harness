import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import { renderMarkdown } from "@fleet-console/markdown/core";
import type { Translate } from "@fleet-console/sdk/i18n";

import { getGlobalSettingsStoreState } from "../global-settings-store.js";
import { diagramHydratorLabels, formatRelativeTime, getT, markdownCopyOptions, type CoreMessageKey } from "../i18n/index.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";
import {
  decideDrydock,
  fetchConflictDetail,
  fetchConflicts,
  fetchDrydock,
  fetchDrydockDetail,
  fetchEntry,
  fetchSchemaDocument,
} from "./api.js";
import type {
  ConflictDetailResponse,
  ConflictListItem,
  DrydockDetailResponse,
  DrydockListItem,
  DrydockMeta,
} from "./api.js";
import { renderMetaChips, renderTagChips } from "./components/meta-chips.js";
import { installTocScrollSpy, renderTocSheet } from "./components/toc-sheet.js";
import { mountCoworkInline } from "./cowork-controller.js";
import type { CoworkController } from "./cowork-controller.js";
import { entryPath } from "./router.js";
import { getState } from "./state.js";
import { escapeAttribute, escapeHtml } from "./utils.js";

type T = Translate<CoreMessageKey>;

function resolveActiveLocale() {
  const preference = getGlobalSettingsStoreState().state?.language ?? "auto";
  const navigatorLanguage =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language.toLowerCase()
      : "";
  return resolveConsoleLanguage(preference, navigatorLanguage);
}

function consoleT(): T {
  return getT(resolveActiveLocale());
}

function consoleLocale() {
  return resolveActiveLocale();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReadingController {
  destroy(): void;
  setEntry(entryId: string): Promise<void>;
  navigateSub(subId: string | undefined): Promise<void>;
  refreshCallbacks(next: Partial<Pick<MountReadingOptions, "onPatchOpen" | "onConflictOpen" | "onDecided" | "onRelatedClick" | "onClose" | "theaterId">>): void;
  /** 로케일 변경 시 현재 문서·스크롤을 유지한 채 문구만 다시 그린다. */
  refreshLocale(): Promise<void>;
}

export interface MountReadingOptions {
  readonly initialEntryId: string;
  readonly kind: "entry" | "drydock" | "conflicts" | "schema";
  readonly subId?: string;
  readonly theaterId: string | null;
  readonly onRelatedClick: (id: string) => void;
  readonly onClose: () => void;
  /** 패치 행 클릭(상세 진입) 또는 뒤로가기(undefined) 콜백 */
  readonly onPatchOpen?: (patchId: string | undefined) => void;
  readonly onConflictOpen?: (conflictId: string | undefined) => void;
  /** 승인/반려 결정 완료 후 목록 갱신을 트리거하는 콜백 */
  readonly onDecided?: () => void;
  readonly onEntryRendered?: (entryId: string) => void;
  readonly onTocChanged?: (count: number) => void;
  readonly tocContainer: HTMLElement;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OP_BADGE_GLYPHS: Record<string, string> = { create_wiki: "+", update_wiki: "↻" };

function opLabel(op: string, t: T): string {
  if (op === "create_wiki") return t("codex.reading.opCreate");
  if (op === "update_wiki") return t("codex.reading.opUpdate");
  return t("codex.reading.opPatch");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function mountReadingInto(
  readContainer: HTMLElement,
  opts: MountReadingOptions,
): ReadingController {
  let destroyed = false;
  let schemaRequestEpoch = 0;
  let cleanupSpy: (() => void) | null = null;
  let coworkController: CoworkController | null = null;
  // relocate(split↔overlay) 시 현재 마운트 소유자의 콜백이 반영되도록 가변 참조로 유지
  let liveOpts = opts;
  let currentEntryId = opts.kind === "entry" ? opts.initialEntryId : "";
  let currentSubId = opts.subId;

  // 드라이독 결정 상태 (패치 상세 뷰에서 관리)
  type DecisionPhase = "idle" | "approving" | "rejecting" | "submitting";
  let decisionPhase: DecisionPhase = "idle";
  let decisionError: string | null = null;
  let currentDetailMeta: DrydockMeta | null = null;
  let currentDetailPatchId: string | null = null;

  installDiagramHydrator(readContainer, diagramHydratorLabels(consoleT()));

  function handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const copyButton = target.closest<HTMLElement>('[data-action="copy-code"]');
    if (copyButton) {
      const code = copyButton.closest("pre")?.getAttribute("data-code");
      if (code) copyCodeToClipboard(copyButton, code);
      return;
    }

    const wikiLink = target.closest<HTMLAnchorElement>('a[href^="/entry/"]');
    if (wikiLink) {
      event.preventDefault();
      const entryId = decodeURIComponent(wikiLink.pathname.slice("/entry/".length));
      if (entryId) liveOpts.onRelatedClick(entryId);
      return;
    }

    // 패치 행 클릭 (목록 → 상세 또는 뒤로가기)
    const patchRowBtn = target.closest<HTMLElement>("[data-patch-id]");
    if (patchRowBtn) {
      event.preventDefault();
      const patchId = patchRowBtn.dataset.patchId || undefined;
      liveOpts.onPatchOpen?.(patchId);
      return;
    }

    const conflictRowBtn = target.closest<HTMLElement>("[data-conflict-id]");
    if (conflictRowBtn) {
      event.preventDefault();
      liveOpts.onConflictOpen?.(conflictRowBtn.dataset.conflictId || undefined);
      return;
    }

    // Related 엔트리 클릭
    const relatedBtn = target.closest<HTMLElement>("[data-entry-id]");
    if (relatedBtn?.dataset.entryId) {
      event.preventDefault();
      liveOpts.onRelatedClick(relatedBtn.dataset.entryId);
      return;
    }

    // 드라이독 결정/뒤로가기 액션
    const drydockBtn = target.closest<HTMLElement>("[data-drydock-action]");
    if (drydockBtn) {
      event.preventDefault();
      handleDrydockAction(drydockBtn.dataset.drydockAction);
      return;
    }

  }

  function handleDrydockAction(action: string | undefined): void {
    if (!action) return;

    if (action === "back") {
      liveOpts.onPatchOpen?.(undefined);
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
        decisionError = consoleT()("codex.reading.rejectReasonRequired");
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
      await decideDrydock(liveOpts.theaterId, currentDetailPatchId, action, reason);
      liveOpts.onDecided?.();
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
    coworkController?.destroy();
    coworkController = null;
    cleanupSpy?.();
    cleanupSpy = null;
  }

  async function renderEntryView(entryId: string): Promise<void> {
    if (destroyed) return;
    showLoading(readContainer, opts.tocContainer);
    opts.onTocChanged?.(0);
    cleanupReader();

    try {
      const entry = await fetchEntry(liveOpts.theaterId, entryId);
      if (destroyed) return;

      const { index } = getState();
      const t = consoleT();
      const { html: markdownHtml, toc } = renderMarkdown(entry.body, {
        omitDuplicateTitle: entry.frontmatter.title,
        resolveWikiLink: (id) => entryPath(id),
        ...markdownCopyOptions(t),
      });

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
        </article>
      `;

      opts.tocContainer.innerHTML = renderTocSheet(toc);
      opts.onTocChanged?.(toc.length);
      const article = readContainer.querySelector<HTMLElement>("article");
      if (article && toc.length > 0) {
        cleanupSpy = installTocScrollSpy(article, toc, opts.tocContainer);
      }
      // 별도 화면 전환 없이 리딩 뷰 자체를 Cowork로 증강한다(드래그 → Comment → 도크).
      const body = readContainer.querySelector<HTMLElement>("#codex-reader-body");
      if (article && body) {
        coworkController = mountCoworkInline({
          theaterId: liveOpts.theaterId,
          entryId,
          title: entry.frontmatter.title,
          article,
          body,
          onApplied: () => { void renderEntryView(entryId); },
        });
      }
      opts.onEntryRendered?.(entryId);
    } catch (error) {
      if (!destroyed) showError(readContainer, opts.tocContainer, error);
    }
  }

  async function renderDrydockView(patchId: string | undefined): Promise<void> {
    if (destroyed) return;
    showLoading(readContainer, opts.tocContainer);
    opts.onTocChanged?.(0);
    cleanupReader();

    // 새 뷰 진입 시 결정 상태 초기화
    currentDetailMeta = null;
    currentDetailPatchId = null;
    decisionPhase = "idle";
    decisionError = null;

    try {
      if (patchId) {
        const detail = await fetchDrydockDetail(liveOpts.theaterId, patchId);
        if (destroyed) return;

        currentDetailMeta = detail.meta;
        currentDetailPatchId = patchId;

        const t = consoleT();
        const { html: markdownHtml, toc } = renderMarkdown(detail.wikiEntry.body, {
          omitDuplicateTitle: detail.wikiEntry.title,
          resolveWikiLink: (id) => entryPath(id),
          ...markdownCopyOptions(t),
        });

        readContainer.innerHTML = renderPatchDetail(detail, markdownHtml);

        opts.tocContainer.innerHTML = renderTocSheet(toc);
        const article = readContainer.querySelector<HTMLElement>("article");
        if (article && toc.length > 0) {
          cleanupSpy = installTocScrollSpy(article, toc, opts.tocContainer);
        }
      } else {
        const list = await fetchDrydock(liveOpts.theaterId, "pending");
        if (destroyed) return;
        opts.tocContainer.innerHTML = "";
        opts.onTocChanged?.(0);
        readContainer.innerHTML = renderDrydockList(list.items, consoleT()("codex.reading.reviewQueuePending"));
      }
    } catch (error) {
      if (!destroyed) showError(readContainer, opts.tocContainer, error);
    }
  }

  async function renderConflictsView(conflictId: string | undefined): Promise<void> {
    if (destroyed) return;
    showLoading(readContainer, opts.tocContainer);
    opts.onTocChanged?.(0);
    cleanupReader();

    try {
      if (conflictId) {
        const detail = await fetchConflictDetail(liveOpts.theaterId, conflictId);
        if (destroyed) return;
        opts.tocContainer.innerHTML = "";
        opts.onTocChanged?.(0);
        readContainer.innerHTML = renderConflictDetail(detail);
      } else {
        const conflicts = await fetchConflicts(liveOpts.theaterId);
        if (destroyed) return;
        opts.tocContainer.innerHTML = "";
        opts.onTocChanged?.(0);
        readContainer.innerHTML = renderConflictList(conflicts);
      }
    } catch (error) {
      if (!destroyed) showError(readContainer, opts.tocContainer, error);
    }
  }

  async function renderSchemaView(templateId: string | undefined): Promise<void> {
    const requestEpoch = ++schemaRequestEpoch;
    const theaterId = liveOpts.theaterId;
    showLoading(readContainer, opts.tocContainer);
    opts.onTocChanged?.(0);
    cleanupReader();
    try {
      const document = await fetchSchemaDocument(theaterId, templateId);
      if (destroyed || requestEpoch !== schemaRequestEpoch || theaterId !== liveOpts.theaterId) return;
      const t = consoleT();
      const { html, toc } = renderMarkdown(document.content, markdownCopyOptions(t));
      const schemaLabel = templateId ?? t("codex.reading.workspaceSchema");
      readContainer.innerHTML = `<article class="document"><header class="document-header"><nav class="breadcrumb"><ol><li><span>Codex</span></li><li><span>${escapeHtml(t("codex.reading.schema"))}</span></li><li><span aria-current="page">${escapeHtml(schemaLabel)}</span></li></ol></nav><h1>${escapeHtml(schemaLabel)}</h1><span class="queue-dl-mono">${escapeHtml(document.ref)}</span></header><div class="markdown-body" id="codex-reader-body">${html}</div></article>`;
      opts.tocContainer.innerHTML = renderTocSheet(toc);
    } catch (error) {
      if (!destroyed && requestEpoch === schemaRequestEpoch && theaterId === liveOpts.theaterId) {
        showError(readContainer, opts.tocContainer, error);
      }
    }
  }

  if (opts.kind === "entry" && opts.initialEntryId) {
    void renderEntryView(opts.initialEntryId);
  } else if (opts.kind === "drydock") {
    void renderDrydockView(opts.subId);
  } else if (opts.kind === "conflicts") {
    void renderConflictsView(opts.subId);
  } else if (opts.kind === "schema") {
    void renderSchemaView(opts.subId);
  }

  return {
    destroy(): void {
      destroyed = true;
      schemaRequestEpoch += 1;
      readContainer.removeEventListener("click", handleClick);
      cleanupReader();
      coworkController?.destroy();
    },
    async setEntry(entryId: string): Promise<void> {
      currentEntryId = entryId;
      await renderEntryView(entryId);
    },
    async navigateSub(subId: string | undefined): Promise<void> {
      currentSubId = subId;
      if (opts.kind === "drydock") {
        await renderDrydockView(subId);
      } else if (opts.kind === "conflicts") {
        await renderConflictsView(subId);
      } else if (opts.kind === "schema") {
        await renderSchemaView(subId);
      }
    },
    refreshCallbacks(next): void {
      liveOpts = { ...liveOpts, ...next };
    },
    async refreshLocale(): Promise<void> {
      if (destroyed) return;
      const scrollParent = readContainer.parentElement;
      const scrollTop = scrollParent?.scrollTop ?? 0;
      installDiagramHydrator(readContainer, diagramHydratorLabels(consoleT()));
      if (opts.kind === "entry" && currentEntryId) {
        await renderEntryView(currentEntryId);
      } else if (opts.kind === "drydock") {
        await renderDrydockView(currentSubId);
      } else if (opts.kind === "conflicts") {
        await renderConflictsView(currentSubId);
      } else if (opts.kind === "schema") {
        await renderSchemaView(currentSubId);
      }
      if (scrollParent) {
        requestAnimationFrame(() => {
          scrollParent.scrollTop = scrollTop;
        });
      }
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function showLoading(readContainer: HTMLElement, tocContainer: HTMLElement): void {
  readContainer.innerHTML = `<div class="codex-reader-loading" aria-live="polite" aria-busy="true">${escapeHtml(consoleT()("common.loading"))}</div>`;
  tocContainer.innerHTML = "";
}

function showError(readContainer: HTMLElement, tocContainer: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  readContainer.innerHTML = `<div class="codex-reader-error" role="alert">${escapeHtml(message)}</div>`;
  tocContainer.innerHTML = "";
}

function renderSheetBreadcrumb(title: string): string {
  const t = consoleT();
  return `
    <nav class="breadcrumb" aria-label="${escapeAttribute(t("codex.reading.entryLocationAria"))}">
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
  const t = consoleT();
  return `
    <section class="related-list">
      <h2>${escapeHtml(t("codex.reading.relatedEntries"))}</h2>
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
  const t = consoleT();
  if (items.length === 0) {
    return `<div class="codex-reader-empty"><p class="queue-empty">${escapeHtml(t("codex.reading.noPendingPatches"))}</p></div>`;
  }
  return `
    <article class="document">
      <header class="document-header">
        <nav class="breadcrumb" aria-label="${escapeAttribute(t("codex.reading.entryLocationAria"))}">
          <ol>
            <li><span>Codex</span></li>
            <li><span aria-current="page">${escapeHtml(t("codex.reading.reviewQueue"))}</span></li>
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
  const t = consoleT();
  const op = item.op ?? "create_wiki";
  const glyph = OP_BADGE_GLYPHS[op] ?? "?";
  const label = opLabel(op, t);
  const target = item.target ?? item.id;
  const createdAtMs = new Date(item.meta.createdAt).getTime();
  const time = Number.isNaN(createdAtMs) ? "" : formatRelativeTime(createdAtMs, consoleLocale());
  const metaParts = [time].filter(Boolean);
  return `
    <button class="queue-row" type="button" data-patch-id="${escapeAttribute(item.id)}" aria-label="${escapeAttribute(label + ": " + target)}">
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
  const t = consoleT();
  const { patch, meta, wikiEntry, targetExists } = detail;
  const op = patch.frontmatter.op;
  const glyph = OP_BADGE_GLYPHS[op] ?? "?";
  const label = opLabel(op, t);
  const targetLabel = targetExists ? t("codex.reading.replaceExisting") : t("codex.reading.createNew");
  const isPending = meta.status === "pending";

  return `
    <article class="document">
      <header class="document-header">
        <nav class="breadcrumb" aria-label="${escapeAttribute(t("codex.reading.entryLocationAria"))}">
          <ol>
            <li><span>Codex</span></li>
            <li><span>${escapeHtml(t("codex.reading.reviewQueue"))}</span></li>
            <li><span aria-current="page">${escapeHtml(label)}</span></li>
          </ol>
        </nav>
        <button type="button" class="queue-back-btn" data-drydock-action="back">${escapeHtml(t("codex.reading.backQueue"))}</button>
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
  const t = consoleT();
  if (phase === "submitting") {
    return `<span class="queue-action-spinner" role="status" aria-label="${escapeAttribute(t("codex.reading.processingAria"))}"></span>`;
  }
  if (phase === "approving") {
    return `
      <p class="queue-decision-confirm">${escapeHtml(t("codex.reading.applyConfirm"))}</p>
      <div class="queue-action-buttons">
        <button type="button" class="queue-action-btn queue-action-btn--approve" data-drydock-action="approve-confirm">${escapeHtml(t("codex.reading.yesApprove"))}</button>
        <button type="button" class="queue-action-btn queue-action-btn--cancel" data-drydock-action="cancel">${escapeHtml(t("common.cancel"))}</button>
      </div>
      ${error ? `<p class="queue-action-error">${escapeHtml(error)}</p>` : ""}
    `;
  }
  if (phase === "rejecting") {
    return `
      <div class="queue-reject-form">
        <textarea class="queue-reject-textarea" id="queue-reject-reason" placeholder="${escapeAttribute(t("codex.reading.rejectPlaceholder"))}" rows="3"></textarea>
        <div class="queue-action-buttons">
          <button type="button" class="queue-action-btn queue-action-btn--reject-submit" data-drydock-action="reject-submit">${escapeHtml(t("codex.reading.submitRejection"))}</button>
          <button type="button" class="queue-action-btn queue-action-btn--cancel" data-drydock-action="cancel">${escapeHtml(t("common.cancel"))}</button>
        </div>
        ${error ? `<p class="queue-action-error">${escapeHtml(error)}</p>` : ""}
      </div>
    `;
  }
  // idle
  return `
    <div class="queue-action-buttons">
      <button type="button" class="queue-action-btn queue-action-btn--approve" data-drydock-action="approve">${escapeHtml(t("codex.reading.approve"))}</button>
      <button type="button" class="queue-action-btn queue-action-btn--reject" data-drydock-action="reject">${escapeHtml(t("codex.reading.reject"))}</button>
    </div>
  `;
}

function renderDecidedState(meta: DrydockMeta): string {
  const t = consoleT();
  const isAccepted = meta.status === "accepted";
  const label = isAccepted ? t("codex.reading.approved") : t("codex.reading.rejected");
  const cls = isAccepted ? "queue-decision-decided--approve" : "queue-decision-decided--reject";
  const reason = meta.reason ? ` · ${escapeHtml(meta.reason)}` : "";
  return `<p class="queue-decision-decided ${cls}">${escapeHtml(label)}${reason}</p>`;
}

function renderConflictDetail(detail: ConflictDetailResponse): string {
  const t = consoleT();
  const status = (detail.meta?.status as string | undefined) ?? t("codex.reading.conflictOpen");
  return `
    <article class="document">
      <header class="document-header">
        <nav class="breadcrumb" aria-label="${escapeAttribute(t("codex.reading.entryLocationAria"))}">
          <ol><li><span>Codex</span></li><li><span>${escapeHtml(t("codex.reading.conflicts"))}</span></li></ol>
        </nav>
        <h1>${escapeHtml(detail.id)}</h1>
        <p class="eyebrow">${escapeHtml(t("codex.reading.conflictEyebrow", { status }))}</p>
      </header>
      <div class="markdown-body">
        ${detail.current ? `<h2>${escapeHtml(t("codex.reading.current"))}</h2><pre><code>${escapeHtml(detail.current)}</code></pre>` : ""}
        ${detail.proposed ? `<h2>${escapeHtml(t("codex.reading.proposed"))}</h2><pre><code>${escapeHtml(detail.proposed)}</code></pre>` : ""}
      </div>
    </article>
  `;
}

function copyCodeToClipboard(button: HTMLElement, code: string): void {
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  let write: Promise<void>;
  try {
    write = clipboard.writeText(code);
  } catch {
    return;
  }
  const original = button.textContent;
  void write.then(() => {
    if (!button.isConnected) return;
    button.textContent = consoleT()("codex.cowork.copied");
    window.setTimeout(() => {
      if (button.isConnected) button.textContent = original;
    }, 1_200);
  }).catch(() => undefined);
}

function renderConflictList(conflicts: ConflictListItem[]): string {
  const t = consoleT();
  if (conflicts.length === 0) {
    return `<div class="codex-reader-empty"><p>${escapeHtml(t("codex.reading.noConflicts"))}</p></div>`;
  }
  return `
    <article class="document">
      <header class="document-header">
        <h1>${escapeHtml(t("codex.reading.conflicts"))}</h1>
      </header>
      <div class="markdown-body">
        <ul class="queue-list">
          ${conflicts
            .map(
              (item) =>
                `<li class="queue-item">
                  <button class="queue-row conflict-row" type="button" data-conflict-id="${escapeAttribute(item.id)}" aria-label="${escapeAttribute(t("codex.reading.openConflict", { title: item.title || item.id }))}">
                    <span class="queue-row-body">
                      <strong class="queue-row-target">${escapeHtml(item.title || item.id)}</strong>
                      <span class="eyebrow">${escapeHtml(item.status)}</span>
                    </span>
                  </button>
                </li>`,
            )
            .join("")}
        </ul>
      </div>
    </article>
  `;
}
