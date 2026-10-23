import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import { renderMarkdown } from "@fleet-console/markdown/core";
import type { TocItem } from "@fleet-console/markdown/core";
import type { Translate } from "@fleet-console/i18n";
import type { ClientNavigateCapability } from "../../../workspace/shared/navigation.js";
import { mountCodexFileLinks, resolveCodexFileLink } from "./file-links.js";

import { diagramHydratorLabels, formatRelativeTime, getT, markdownCopyOptions, type CoreMessageKey } from "../i18n/index.js";
import { resolveActiveLocale } from "../i18n/index.js";
import {
  CodexRequestError,
  fetchEntry,
  deleteEntry,
  restoreEntry,
  fetchSchemaDocument,
} from "./api.js";
import type {
  EntryBacklink,
  EntryResponse,
} from "./api.js";
import { installEntryLinkPreview } from "./components/link-preview.js";
import type { EntryLinkPreview } from "./components/link-preview.js";
import { renderMetaChips, renderTagChips } from "./components/meta-chips.js";
import { installTocScrollSpy, renderTocSheet } from "./components/toc-sheet.js";
import { mountQuoteSelection } from "./quote-controller.js";
import type { QuoteSelectionController } from "./quote-controller.js";
import { CODEX_LIVE_CHANGED_EVENT } from "./live.js";
import type { CodexLiveChangedDetail } from "./live.js";
import { getState } from "./state.js";
import { entryPath, escapeAttribute, escapeHtml } from "./utils.js";

type T = Translate<CoreMessageKey>;

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
  /**
   * 스크롤 스파이를 현재 스크롤 루트 위에 다시 세운다. 리더 노드가 split↔확대로 relocate되면
   * 스파이의 스크롤·크기 리스너는 설치 시점의 루트(옛 스크롤 컨테이너)를 계속 붙잡고 있어 새
   * 컨테이너의 스크롤을 영영 듣지 못한다 — 노드를 옮긴 쪽이 이 함수를 불러야 목차가 다시 읽는
   * 위치를 따라온다.
   */
  refreshScrollSpy(): void;
  /** 헤드바·링크 복사·원문 보기가 쓰는 현재 문서 사실. */
  getDocument(): ReaderDocument | null;
  refreshCallbacks(next: Partial<Pick<MountReadingOptions, "onRelatedClick" | "onClose" | "onTagClick" | "theaterId" | "fileTheaterId" | "navigate">>): void;
  /** 로케일 변경 시 현재 문서·스크롤을 유지한 채 문구만 다시 그린다. */
  refreshLocale(): Promise<void>;
}

export interface ReaderDocument {
  readonly entryId: string;
  readonly title: string;
  readonly markdown: string;
}

export interface MountReadingOptions {
  /** 현재 문서가 바뀌거나 비워졌음을 호스트에 알린다(헤드바 제목·링크 복사·원문의 출처). */
  readonly onDocumentChanged?: () => void;
  readonly initialEntryId: string;
  readonly kind: "entry" | "schema";
  readonly subId?: string;
  readonly theaterId: string | null;
  readonly fileTheaterId?: string | null;
  readonly navigate?: ClientNavigateCapability;
  readonly onRelatedClick: (id: string) => void;
  readonly onClose: () => void;
  /** 문서 헤더 태그 칩 클릭 — 카탈로그 태그 필터로 라우팅된다. */
  readonly onTagClick?: (tag: string) => void;
  readonly onEntryRendered?: (entryId: string) => void;
  readonly onTocChanged?: (count: number) => void;
  readonly tocContainer: HTMLElement;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DELETE_ARM_MS = 4000;
const DELETE_CONFIRM_GAP_MS = 350;
const DELETE_TOAST_MS = 7000;

// ─── Public API ───────────────────────────────────────────────────────────────

export function mountReadingInto(
  readContainer: HTMLElement,
  opts: MountReadingOptions,
): ReadingController {
  let destroyed = false;
  let entryRequestEpoch = 0;
  let schemaRequestEpoch = 0;
  let cleanupSpy: (() => void) | null = null;
  // 재부착에 필요한 마지막 설치 인자 — relocate 후 같은 문서 위에 스파이를 다시 세운다.
  let spyContext: { article: HTMLElement; items: TocItem[] } | null = null;
  let currentDocument: ReaderDocument | null = null;
  let quoteController: QuoteSelectionController | null = null;
  // relocate(split↔overlay) 시 현재 마운트 소유자의 콜백이 반영되도록 가변 참조로 유지
  let liveOpts = opts;
  const fileLinks = mountCodexFileLinks({
    container: readContainer,
    getTheaterId: () => liveOpts.fileTheaterId ?? liveOpts.theaterId,
    getNavigate: () => liveOpts.navigate,
  });
  let currentEntryId = opts.kind === "entry" ? opts.initialEntryId : "";
  let currentSubId = opts.subId;

  // 읽는 중인 문서가 서버에서 바뀌었다는 사실. 본문은 그대로 두고 이 표식만 띄운다.
  let staleKind: "updated" | "deleted" | null = null;
  // 지금 화면에 그려진 문서의 갱신 시각. 카탈로그의 같은 값과 어긋나면 이 문서가 바뀐 것이다.
  let renderedEntryStamp: string | null = null;
  let renderedSchemaStamp: string | null = null;
  let currentEntryHash: string | null = null;
  let deleteArmedAt: number | null = null;
  let deleteBusy = false;
  let deleteTimer: ReturnType<typeof setTimeout> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let undoDeletion: { entryId: string; theaterId: string | null; historyRef: string } | null = null;


  installDiagramHydrator(readContainer, diagramHydratorLabels(consoleT()));
  const linkPreview: EntryLinkPreview = installEntryLinkPreview(readContainer, () => liveOpts.theaterId);

  function handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest("[data-reader-dismiss]")) { event.preventDefault(); liveOpts.onClose(); return; }
    const readerRefresh = target.closest<HTMLElement>("[data-reader-refresh]");
    if (readerRefresh) {
      event.preventDefault();
      void reloadCurrentView();
      return;
    }

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


    if (target.closest("[data-entry-delete]") && currentEntryId) {
      event.preventDefault();
      pressDelete();
      return;
    }
    if (target.closest("[data-entry-undo]")) {
      event.preventDefault();
      void undoDelete();
      return;
    }

    // 문서 헤더 태그 칩 — 카탈로그의 같은 시각 어휘와 같은 약속(태그 필터)으로 응답한다.
    const docTag = target.closest<HTMLElement>("[data-doc-tag]");
    if (docTag?.dataset.docTag) {
      event.preventDefault();
      liveOpts.onTagClick?.(docTag.dataset.docTag);
      return;
    }

    // 태그 칩 접힘 토글(+N ↔ −) — 재렌더 없이 컨테이너 상태만 뒤집는다.
    const chipsToggle = target.closest<HTMLElement>("[data-chips-toggle]");
    if (chipsToggle) {
      event.preventDefault();
      const chips = chipsToggle.closest<HTMLElement>(".meta-chips");
      if (!chips) return;
      const collapsed = chips.dataset.collapsed !== "true";
      chips.dataset.collapsed = String(collapsed);
      chipsToggle.setAttribute("aria-expanded", String(!collapsed));
      const overflowCount = chips.querySelectorAll(".chip-tag--overflow").length;
      const t = consoleT();
      chipsToggle.textContent = collapsed ? `+${overflowCount}` : "−";
      chipsToggle.setAttribute(
        "aria-label",
        collapsed ? t("codex.meta.moreTags", { count: overflowCount }) : t("codex.meta.collapseTags"),
      );
      return;
    }


    // Related 엔트리 클릭
    const relatedBtn = target.closest<HTMLElement>("[data-entry-id]");
    if (relatedBtn?.dataset.entryId) {
      event.preventDefault();
      liveOpts.onRelatedClick(relatedBtn.dataset.entryId);
      return;
    }


  }

  function resetDelete(): void {
    if (deleteTimer) clearTimeout(deleteTimer);
    deleteTimer = null;
    deleteArmedAt = null;
    const button = readContainer.querySelector<HTMLButtonElement>("[data-entry-delete]");
    if (button) {
      button.textContent = consoleT()("codex.reading.delete");
      button.removeAttribute("data-armed");
    }
    const hint = readContainer.querySelector<HTMLElement>("[data-entry-delete-hint]");
    if (hint) hint.textContent = "";
  }

  function pressDelete(): void {
    if (deleteBusy || staleKind === "deleted" || !currentEntryHash) return;
    const now = Date.now();
    if (deleteArmedAt !== null && now - deleteArmedAt < DELETE_ARM_MS) {
      if (now - deleteArmedAt >= DELETE_CONFIRM_GAP_MS) void submitDelete();
      return;
    }
    resetDelete();
    deleteArmedAt = now;
    const button = readContainer.querySelector<HTMLButtonElement>("[data-entry-delete]");
    if (button) { button.textContent = consoleT()("codex.reading.deleteConfirm"); button.dataset.armed = "true"; }
    const hint = readContainer.querySelector<HTMLElement>("[data-entry-delete-hint]");
    if (hint) hint.textContent = consoleT()("codex.reading.deleteHint");
    deleteTimer = setTimeout(resetDelete, DELETE_ARM_MS);
  }

  async function submitDelete(): Promise<void> {
    const entryId = currentEntryId, theaterId = liveOpts.theaterId, epoch = entryRequestEpoch;
    const expectedHash = currentEntryHash!;
    const current = () => !destroyed && epoch === entryRequestEpoch && entryId === currentEntryId && theaterId === liveOpts.theaterId;
    resetDelete();
    deleteBusy = true;
    const button = readContainer.querySelector<HTMLButtonElement>("[data-entry-delete]");
    if (button) button.disabled = true;
    const errorLabel = readContainer.querySelector<HTMLElement>("[data-entry-delete-error]");
    if (errorLabel) errorLabel.textContent = "";
    try {
      const result = await deleteEntry(theaterId, entryId, expectedHash);
      if (!current()) return;
      showStaleNotice("deleted");
      undoDeletion = { entryId, theaterId, historyRef: result.historyRef };
      showDeleteToast();
    } catch (error) {
      if (!current()) return;
      if (error instanceof CodexRequestError && error.status === 404) showStaleNotice("deleted");
      else if (error instanceof CodexRequestError && error.code === "entry_changed") {
        const reload = renderEntryView(entryId);
        const reloadEpoch = entryRequestEpoch;
        await reload;
        if (destroyed || reloadEpoch !== entryRequestEpoch || entryId !== currentEntryId || theaterId !== liveOpts.theaterId) return;
        const label = readContainer.querySelector<HTMLElement>("[data-entry-delete-error]");
        if (label) label.textContent = consoleT()("codex.reading.entryChanged");
      } else if (errorLabel) errorLabel.textContent = consoleT()("codex.reading.deleteFailed");
    } finally {
      deleteBusy = false;
      if (current() && staleKind !== "deleted" && button?.isConnected) button.disabled = false;
    }
  }

  function clearDeleteToast(): void {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    undoDeletion = null;
    readContainer.querySelector(".codex-delete-toast")?.remove();
  }

  function showDeleteToast(): void {
    if (toastTimer) clearTimeout(toastTimer);
    readContainer.querySelector(".codex-delete-toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "codex-delete-toast";
    toast.setAttribute("role", "status");
    toast.innerHTML = `<span>${escapeHtml(consoleT()("codex.reading.deleted"))}</span><button type="button" class="codex-delete-undo" data-entry-undo>${escapeHtml(consoleT()("codex.reading.undoDelete"))}</button>`;
    readContainer.prepend(toast);
    toastTimer = setTimeout(clearDeleteToast, DELETE_TOAST_MS);
  }

  async function undoDelete(): Promise<void> {
    const deletion = undoDeletion;
    const button = readContainer.querySelector<HTMLButtonElement>("[data-entry-undo]");
    if (!deletion || button?.disabled) return;
    if (toastTimer) clearTimeout(toastTimer);
    if (button) button.disabled = true;
    const epoch = entryRequestEpoch;
    try {
      await restoreEntry(deletion.theaterId, deletion.entryId, deletion.historyRef);
      if (destroyed || epoch !== entryRequestEpoch || deletion !== undoDeletion || deletion.theaterId !== liveOpts.theaterId) return;
      clearDeleteToast();
      await renderEntryView(deletion.entryId);
    } catch (error) {
      if (destroyed || epoch !== entryRequestEpoch || deletion !== undoDeletion || deletion.theaterId !== liveOpts.theaterId) return;
      if (error instanceof CodexRequestError && error.code === "entry_exists") {
        clearDeleteToast();
        await renderEntryView(deletion.entryId);
        return;
      }
      const label = readContainer.querySelector<HTMLElement>(".codex-delete-toast span");
      if (label) label.textContent = consoleT()("codex.reading.restoreFailed");
      if (button) button.disabled = false;
      toastTimer = setTimeout(clearDeleteToast, DELETE_TOAST_MS);
    }
  }

  readContainer.addEventListener("click", handleClick);

  function installSpy(article: HTMLElement, items: TocItem[]): void {
    cleanupSpy?.();
    spyContext = { article, items };
    cleanupSpy = installTocScrollSpy(article, items, opts.tocContainer);
  }

  function cleanupReader(): void {
    fileLinks.close();
    quoteController?.destroy();
    quoteController = null;
    cleanupSpy?.();
    cleanupSpy = null;
    spyContext = null;
    if (currentDocument !== null) {
      currentDocument = null;
      // 스키마로 넘어가거나 다음 문서를 못 읽어 온 순간부터 이전 문서는
      // 화면에 없다 — 그 사실을 알리지 않으면 머리줄이 옛 제목을 계속 말한다.
      opts.onDocumentChanged?.();
    }
  }

  /**
   * 목록은 스스로 따라오고, 읽는 중인 본문은 알린 뒤 기다린다.
   *
   * 목록에서 잃을 것은 스크롤 몇 픽셀이지만 본문에서 잃는 것은 읽던 자리다 — 두 화면에
   * 같은 규칙을 적용하면 둘 중 하나는 반드시 나쁘게 동작한다.
   */
  function handleLiveChanged(event: Event): void {
    if (destroyed) return;
    const detail = (event as CustomEvent<CodexLiveChangedDetail>).detail;
    const scopes = new Set(detail?.scopes ?? []);
    if (opts.kind === "entry") {
      if (!currentEntryId) return;
      if (!scopes.has("wiki") && !scopes.has("index")) return;
      // updated 필드가 그대로인 외부 편집과 카탈로그에서 빠진 삭제도 실제 API로 확인한다.
      void noticeForOpenEntry(currentEntryId);
      return;
    }
    if (opts.kind === "schema") {
      if (!scopes.has("schema")) return;
      // 워크스페이스 스키마(subId 없음)도 읽는 문서다 — 읽던 자리를 보존한다.
      void noticeForOpenSchema(currentSubId);
    }
  }

  async function noticeForOpenSchema(templateId: string | undefined): Promise<void> {
    try {
      const document = await fetchSchemaDocument(liveOpts.theaterId, templateId);
      if (destroyed || currentSubId !== templateId) return;
      const stamp = document.content;
      if (renderedSchemaStamp === null) {
        renderedSchemaStamp = stamp;
        return;
      }
      if (stamp === renderedSchemaStamp) return;
      showStaleNotice("updated");
    } catch {
      // 위와 같다.
    }
  }

  function entryStampOf(entry: EntryResponse): string { return JSON.stringify([entry.frontmatter, entry.body]); }

  async function noticeForOpenEntry(entryId: string): Promise<void> {
    const epoch = entryRequestEpoch, theaterId = liveOpts.theaterId;
    try {
      const entry = await fetchEntry(theaterId, entryId);
      if (destroyed || epoch !== entryRequestEpoch || entryId !== currentEntryId || theaterId !== liveOpts.theaterId) return;
      if (renderedEntryStamp !== null && entryStampOf(entry) !== renderedEntryStamp) showStaleNotice("updated");
    } catch (error) {
      if (!destroyed && epoch === entryRequestEpoch && entryId === currentEntryId && theaterId === liveOpts.theaterId && error instanceof CodexRequestError && error.status === 404) showStaleNotice("deleted");
    }
  }

  function showStaleNotice(kind: "updated" | "deleted"): void {
    // 한 번도 표시하지 못한 문서에는 보존된 사본이 없다. 실제 읽던 문서의 삭제만 안내한다.
    if (kind === "deleted" && renderedEntryStamp === null) return;
    // 삭제 사실은 단순 갱신보다 강한 소식이다.
    if (staleKind === "deleted" && kind === "updated") return;
    staleKind = kind;
    if (kind === "deleted") {
      readContainer.querySelector<HTMLButtonElement>("[data-entry-delete]")?.setAttribute("disabled", "");
    }
    const t = consoleT();
    const label = kind === "deleted" ? t("codex.reading.staleDeleted") : t("codex.reading.staleUpdated");
    const action = kind === "deleted" ? t("common.close") : t("codex.reading.staleReload");
    const existing = readContainer.querySelector<HTMLElement>(".codex-reader-stale");
    const markup = `
      <span class="codex-reader-stale-text">${escapeHtml(label)}</span>
      <button class="codex-reader-stale-action" type="button" ${kind === "deleted" ? "data-reader-dismiss" : "data-reader-refresh"}>${escapeHtml(action)}</button>
    `;
    if (existing) {
      existing.dataset.tone = kind;
      existing.innerHTML = markup;
      return;
    }
    const notice = document.createElement("div");
    notice.className = "codex-reader-stale";
    notice.dataset.tone = kind;
    notice.setAttribute("role", "status");
    notice.innerHTML = markup;
    readContainer.prepend(notice);
  }

  async function reloadCurrentView(): Promise<void> {
    if (opts.kind === "entry") {
      if (currentEntryId) await renderEntryView(currentEntryId);
      return;
    }
    await renderSchemaView(currentSubId);
  }

  async function renderEntryView(entryId: string): Promise<void> {
    if (destroyed) return;
    const requestEpoch = ++entryRequestEpoch;
    currentEntryId = entryId;
    staleKind = null;
    resetDelete();
    clearDeleteToast();
    currentEntryHash = null;
    renderedEntryStamp = null;
    showLoading(readContainer, opts.tocContainer);
    opts.onTocChanged?.(0);
    cleanupReader();

    try {
      const entry = await fetchEntry(liveOpts.theaterId, entryId);
      if (destroyed || requestEpoch !== entryRequestEpoch || entryId !== currentEntryId) return;

      const { index } = getState();
      const t = consoleT();
      const { html: markdownHtml, toc } = renderMarkdown(entry.body, {
        omitDuplicateTitle: entry.frontmatter.title,
        resolveWikiLink: (id) => entryPath(id),
        resolveLink: resolveCodexFileLink,
        ...markdownCopyOptions(t),
      });

      const relatedHtml = renderRelatedList(entry.frontmatter.id, entry.frontmatter.tags, index);
      const backlinksHtml = renderBacklinks(entry.backlinks ?? []);
      // 옆단이 있다는 사실은 클래스로 싣는다 — 넓은 시트의 2열 배치가 `:has(> .related-list)` 대신 이것을 읽는다.
      const documentClass = relatedHtml || backlinksHtml ? "document has-related" : "document";
      readContainer.innerHTML = `
        <article class="${documentClass}">
          <header class="document-header">
            ${renderSheetBreadcrumb(entry.frontmatter.title)}
            <h1>${escapeHtml(entry.frontmatter.title)}</h1>
            ${renderMetaChips(entry.frontmatter, { interactiveTags: true })}
            <div class="codex-entry-actions">
              <button type="button" class="codex-entry-delete" data-entry-delete>${escapeHtml(t("codex.reading.delete"))}</button>
              <span class="codex-entry-delete-hint" data-entry-delete-hint role="status"></span>
              <span class="codex-entry-delete-error" data-entry-delete-error role="alert"></span>
            </div>
          </header>
          <div class="markdown-body" id="codex-reader-body">
            ${markdownHtml}
          </div>
          ${relatedHtml}
          ${backlinksHtml}
        </article>
      `;

      currentEntryHash = entry.hash;
      currentDocument = { entryId, title: entry.frontmatter.title, markdown: entry.body };
      opts.tocContainer.innerHTML = renderTocSheet(toc);
      opts.onTocChanged?.(toc.length);
      const article = readContainer.querySelector<HTMLElement>("article");
      if (article && toc.length > 0) {
        installSpy(article, toc);
      }
      // 본문에서 문장을 고르면 지휘관·사령관 입력창에 인용으로 바로 붙인다(드래그 → 댓글·질문 → 받는 쪽 컴포저).
      const body = readContainer.querySelector<HTMLElement>("#codex-reader-body");
      if (body) void fileLinks.enhanceInlinePaths(body);
      if (article && body) {
        quoteController = mountQuoteSelection({
          theaterId: liveOpts.theaterId,
          entryId,
          title: entry.frontmatter.title,
          article,
          body,
        });
      }
      // 지금 그린 본문이 어느 판본인지 적어 둔다 — 이후 카탈로그의 같은 값과 비교해
      // "이 문서가" 바뀌었는지 판정한다.
      renderedEntryStamp = entryStampOf(entry);
      opts.onEntryRendered?.(entryId);
    } catch (error) {
      if (!destroyed && requestEpoch === entryRequestEpoch && entryId === currentEntryId) {
        showError(readContainer, opts.tocContainer, error);
      }
    }
  }

  async function renderSchemaView(templateId: string | undefined): Promise<void> {
    const requestEpoch = ++schemaRequestEpoch;
    const theaterId = liveOpts.theaterId;
    currentSubId = templateId;
    renderedSchemaStamp = null;
    showLoading(readContainer, opts.tocContainer);
    opts.onTocChanged?.(0);
    cleanupReader();
    try {
      const document = await fetchSchemaDocument(theaterId, templateId);
      if (destroyed || requestEpoch !== schemaRequestEpoch || theaterId !== liveOpts.theaterId) return;
      const t = consoleT();
      const { html, toc } = renderMarkdown(document.content, markdownCopyOptions(t));
      const schemaLabel = templateId ?? t("codex.reading.workspaceSchema");
      readContainer.innerHTML = `<article class="document"><header class="document-header"><nav class="breadcrumb"><ol><li><span>Codex</span></li><li><span>${escapeHtml(t("codex.reading.schema"))}</span></li><li><span aria-current="page">${escapeHtml(schemaLabel)}</span></li></ol></nav><h1>${escapeHtml(schemaLabel)}</h1><span class="codex-schema-ref">${escapeHtml(document.ref)}</span></header><div class="markdown-body" id="codex-reader-body">${html}</div></article>`;
      opts.tocContainer.innerHTML = renderTocSheet(toc);
      renderedSchemaStamp = document.content;
    } catch (error) {
      if (!destroyed && requestEpoch === schemaRequestEpoch && theaterId === liveOpts.theaterId) {
        showError(readContainer, opts.tocContainer, error);
      }
    }
  }

  if (opts.kind === "entry" && opts.initialEntryId) {
    void renderEntryView(opts.initialEntryId);
  } else if (opts.kind === "schema") {
    void renderSchemaView(opts.subId);
  }

  document.addEventListener(CODEX_LIVE_CHANGED_EVENT, handleLiveChanged);

  return {
    destroy(): void {
      resetDelete();
      clearDeleteToast();
      destroyed = true;
      entryRequestEpoch += 1;
      schemaRequestEpoch += 1;
      readContainer.removeEventListener("click", handleClick);
      document.removeEventListener(CODEX_LIVE_CHANGED_EVENT, handleLiveChanged);
      linkPreview.destroy();
      fileLinks.destroy();
      cleanupReader();
      quoteController?.destroy();
    },
    async setEntry(entryId: string): Promise<void> {
      await renderEntryView(entryId);
    },
    async navigateSub(subId: string | undefined): Promise<void> {
      if (opts.kind === "schema") await renderSchemaView(subId);
    },
    refreshScrollSpy(): void {
      if (!spyContext || !spyContext.article.isConnected) return;
      installSpy(spyContext.article, spyContext.items);
    },
    getDocument(): ReaderDocument | null {
      return currentDocument;
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
  const message = error instanceof CodexRequestError ? consoleT()(error.status === 404 ? "codex.reading.entryUnavailable" : "codex.reading.requestFailed") : error instanceof Error ? error.message : String(error);
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

// [[wiki:...]]로 이 문서를 참조하는 엔트리들 — 태그 기반 Related와 달리 실제 인용 관계다.
function renderBacklinks(backlinks: readonly EntryBacklink[]): string {
  if (backlinks.length === 0) return "";
  const t = consoleT();
  return `
    <section class="related-list codex-backlinks">
      <h2>${escapeHtml(t("codex.reading.backlinks"))}</h2>
      <div class="related-items">
        ${backlinks
          .map(
            (item) =>
              `<button class="related-card" type="button" data-entry-id="${escapeAttribute(item.id)}">
                <strong>${escapeHtml(item.title)}</strong>
                <span class="codex-backlink-meta">${escapeHtml(formatRelativeUpdatedIso(item.updated))}</span>
              </button>`,
          )
          .join("")}
      </div>
    </section>
  `;
}

function formatRelativeUpdatedIso(iso: string): string {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? iso : formatRelativeTime(ms, consoleLocale());
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
