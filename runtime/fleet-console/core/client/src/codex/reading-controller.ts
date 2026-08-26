import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import { renderMarkdown, slugifyHeading } from "@fleet-console/markdown/core";
import type { TocItem } from "@fleet-console/markdown/core";
import { diffDraftBlocks } from "@fleet-console/markdown/diff";
import type { DraftBlock } from "@fleet-console/markdown/diff";
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
  DrydockListResponse,
  DrydockMeta,
  EntryBacklink,
} from "./api.js";
import { installEntryLinkPreview } from "./components/link-preview.js";
import type { EntryLinkPreview } from "./components/link-preview.js";
import { renderMetaChips, renderTagChips } from "./components/meta-chips.js";
import { installTocScrollSpy, renderTocSheet } from "./components/toc-sheet.js";
import { mountCoworkInline } from "./cowork-controller.js";
import type { CoworkController } from "./cowork-controller.js";
import { CODEX_LIVE_CHANGED_EVENT } from "./live.js";
import type { CodexLiveChangedDetail } from "./live.js";
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
  refreshCallbacks(next: Partial<Pick<MountReadingOptions, "onPatchOpen" | "onConflictOpen" | "onDecided" | "onRelatedClick" | "onClose" | "onTagClick" | "theaterId">>): void;
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
  /** 문서 헤더 태그 칩 클릭 — 카탈로그 태그 필터로 라우팅된다. */
  readonly onTagClick?: (tag: string) => void;
  readonly onEntryRendered?: (entryId: string) => void;
  readonly onTocChanged?: (count: number) => void;
  readonly tocContainer: HTMLElement;
  /** Cowork 도크가 정박할 프레임 경계 슬롯(스크롤포트 밖). */
  readonly dockContainer?: HTMLElement;
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
  let entryRequestEpoch = 0;
  let subRequestEpoch = 0;
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
  // 대기열 세그먼트·diff 표시 상태 — 목록은 pending/결정됨을 오가고,
  // update 패치 상세는 "변경만"이 기본이다(전문은 토글).
  let queueSegment: "pending" | "decided" = "pending";
  let diffMode: "changes" | "full" = "changes";
  let detailDiffBlocks: readonly DraftBlock[] | null = null;
  let detailProposedToc = "";
  let detailProposedTocItems: readonly TocItem[] = [];
  // 읽는 중인 문서가 서버에서 바뀌었다는 사실. 본문은 그대로 두고 이 표식만 띄운다.
  let staleKind: "updated" | "decided" | null = null;
  // 지금 화면에 그려진 문서의 갱신 시각. 카탈로그의 같은 값과 어긋나면 이 문서가 바뀐 것이다.
  let renderedEntryStamp: string | null = null;
  // 지금 화면에 그려진 패치의 판본. 대기열에서 *다른* 패치가 움직인 것으로는 이 값이 변하지 않는다.
  let renderedPatchStamp: string | null = null;

  installDiagramHydrator(readContainer, diagramHydratorLabels(consoleT()));
  const linkPreview: EntryLinkPreview = installEntryLinkPreview(readContainer, () => liveOpts.theaterId);

  function handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

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

    // 대기열 세그먼트 전환 (대기 ↔ 결정됨)
    const segmentBtn = target.closest<HTMLElement>("[data-queue-segment]");
    if (segmentBtn) {
      event.preventDefault();
      const next = segmentBtn.dataset.queueSegment === "decided" ? "decided" : "pending";
      if (next !== queueSegment) {
        queueSegment = next;
        void renderDrydockView(undefined);
      }
      return;
    }

    // 패치 상세 diff 표시 전환 (변경만 ↔ 전문)
    const diffModeBtn = target.closest<HTMLElement>("[data-diff-mode]");
    if (diffModeBtn) {
      event.preventDefault();
      const next = diffModeBtn.dataset.diffMode === "full" ? "full" : "changes";
      if (next !== diffMode) {
        diffMode = next;
        redrawDiffBody();
      }
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

    const conflictActionBtn = target.closest<HTMLElement>("[data-conflict-action]");
    if (conflictActionBtn?.dataset.conflictAction === "back") {
      event.preventDefault();
      liveOpts.onConflictOpen?.(undefined);
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

  // diff 모드 전환은 본문만 다시 그린다 — 결정 바 상태(확인/사유 입력)를 보존한다.
  function redrawDiffBody(): void {
    const body = readContainer.querySelector<HTMLElement>("[data-diff-body]");
    if (!body || !detailDiffBlocks) return;
    body.innerHTML = renderDiffBlocks(detailDiffBlocks, diffMode);
    readContainer.querySelectorAll<HTMLElement>("[data-diff-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.diffMode === diffMode));
    });
    // 전문 모드에서만 제안 문서의 아웃라인이 실제 DOM과 대응한다 — 재배정된 헤딩 ID 위에
    // 스크롤 스파이를 다시 설치해 아웃라인 활성 표시(aria-current)를 엔트리 뷰와 맞춘다.
    cleanupSpy?.();
    cleanupSpy = null;
    if (diffMode === "full") {
      opts.tocContainer.innerHTML = detailProposedToc;
      opts.onTocChanged?.(detailProposedTocItems.length);
      const article = readContainer.querySelector<HTMLElement>("article");
      if (article && detailProposedTocItems.length > 0) {
        cleanupSpy = installTocScrollSpy(article, [...detailProposedTocItems], opts.tocContainer);
      }
    } else {
      opts.tocContainer.innerHTML = "";
      opts.onTocChanged?.(0);
    }
  }

  readContainer.addEventListener("click", handleClick);

  function cleanupReader(): void {
    coworkController?.destroy();
    coworkController = null;
    cleanupSpy?.();
    cleanupSpy = null;
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
      if (!scopes.has("wiki") && !scopes.has("index")) return;
      if (!currentEntryId) return;
      // 위키에서 *무언가* 바뀌었다고 이 문서가 바뀐 것은 아니다 — 옆 문서가 등재됐을 뿐인데
      // "이 문서가 갱신됐다"고 말하면 그 표식은 곧 아무 뜻도 없는 소음이 된다.
      const stamp = catalogStampFor(currentEntryId);
      if (stamp === null) return;
      if (renderedEntryStamp === null) {
        // 문서를 그릴 때 카탈로그가 아직 비어 있었다 — 지금 값을 기준선으로 삼고,
        // 다음 변화부터 비교한다. 근거 없는 알림보다 한 번 늦는 편이 정직하다.
        renderedEntryStamp = stamp;
        return;
      }
      if (stamp === renderedEntryStamp) return;
      showStaleNotice("updated");
      return;
    }
    if (opts.kind === "drydock") {
      if (!scopes.has("queue")) return;
      if (!currentSubId) {
        void renderDrydockView(undefined);
        return;
      }
      void noticeForOpenPatch(currentSubId);
      return;
    }
    if (opts.kind === "conflicts") {
      if (!scopes.has("conflicts")) return;
      if (!currentSubId) {
        void renderConflictsView(undefined);
        return;
      }
      showStaleNotice("updated");
      return;
    }
    if (opts.kind === "schema") {
      if (!scopes.has("schema")) return;
      // 워크스페이스 스키마(subId 없음)도 목록이 아니라 읽는 문서다 — 대기열·충돌 목록과
      // 달리 말없이 갈아끼우면 읽던 자리를 잃는다.
      showStaleNotice("updated");
    }
  }

  /**
   * 읽던 제안이 밖에서 승인·반려됐다면 그렇게 말해야 한다 — "갱신됐다"로 뭉뚱그리면
   * 사용자는 아직 자기가 결정할 수 있다고 믿은 채 승인 버튼을 누르러 간다.
   */
  async function noticeForOpenPatch(patchId: string): Promise<void> {
    const wasPending = currentDetailMeta?.status === "pending";
    try {
      const detail = await fetchDrydockDetail(liveOpts.theaterId, patchId);
      if (destroyed || currentSubId !== patchId) return;
      if (wasPending && detail.meta.status !== "pending") {
        showStaleNotice("decided");
        return;
      }
      // 대기열에서 *다른* 제안이 움직인 것으로 이 제안이 바뀌지는 않는다 — 판본이 실제로
      // 달라졌을 때만 알린다. 매번 알리면 그 표식은 곧 아무 뜻도 없는 소음이 된다.
      const stamp = patchStampOf(detail);
      if (renderedPatchStamp === null) {
        renderedPatchStamp = stamp;
        return;
      }
      if (stamp === renderedPatchStamp) return;
      showStaleNotice("updated");
    } catch {
      // 조회 자체가 실패했다면 무엇이 달라졌는지 알 수 없다 — 근거 없는 알림은 띄우지 않는다.
    }
  }

  /** 이 패치의 판본 — 결정 상태와 제안 본문이 함께 움직여야 다른 판본이다. */
  function patchStampOf(detail: DrydockDetailResponse): string {
    return `${detail.meta.status}:${detail.meta.decidedAt ?? ""}:${detail.patch.body.length}:${detail.patch.body}`;
  }

  function catalogStampFor(entryId: string): string | null {
    return getState().index.find((entry) => entry.id === entryId)?.updated ?? null;
  }

  function showStaleNotice(kind: "updated" | "decided"): void {
    // 결정 사실은 단순 갱신보다 강한 소식이다 — 한 번 켜지면 갱신 문구로 내려가지 않는다.
    if (staleKind === "decided" && kind === "updated") return;
    staleKind = kind;
    const t = consoleT();
    const label = kind === "decided" ? t("codex.reading.staleDecided") : t("codex.reading.staleUpdated");
    const action = kind === "decided" ? t("codex.reading.staleSeeResult") : t("codex.reading.staleReload");
    const existing = readContainer.querySelector<HTMLElement>(".codex-reader-stale");
    const markup = `
      <span class="codex-reader-stale-text">${escapeHtml(label)}</span>
      <button class="codex-reader-stale-action" type="button" data-reader-refresh>${escapeHtml(action)}</button>
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
    if (opts.kind === "drydock") {
      await renderDrydockView(currentSubId);
      return;
    }
    if (opts.kind === "conflicts") {
      await renderConflictsView(currentSubId);
      return;
    }
    await renderSchemaView(currentSubId);
  }

  async function renderEntryView(entryId: string): Promise<void> {
    if (destroyed) return;
    const requestEpoch = ++entryRequestEpoch;
    currentEntryId = entryId;
    staleKind = null;
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
        ...markdownCopyOptions(t),
      });

      readContainer.innerHTML = `
        <article class="document">
          <header class="document-header">
            ${renderSheetBreadcrumb(entry.frontmatter.title)}
            <h1>${escapeHtml(entry.frontmatter.title)}</h1>
            ${renderMetaChips(entry.frontmatter, { interactiveTags: true })}
          </header>
          <div class="markdown-body" id="codex-reader-body">
            ${markdownHtml}
          </div>
          ${renderRelatedList(entry.frontmatter.id, entry.frontmatter.tags, index)}
          ${renderBacklinks(entry.backlinks ?? [])}
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
          dockHost: opts.dockContainer,
          onApplied: () => { void renderEntryView(entryId); },
        });
      }
      // 지금 그린 본문이 어느 판본인지 적어 둔다 — 이후 카탈로그의 같은 값과 비교해
      // "이 문서가" 바뀌었는지 판정한다.
      renderedEntryStamp = catalogStampFor(entryId);
      opts.onEntryRendered?.(entryId);
    } catch (error) {
      if (!destroyed && requestEpoch === entryRequestEpoch && entryId === currentEntryId) {
        showError(readContainer, opts.tocContainer, error);
      }
    }
  }

  function isCurrentSubRequest(
    kind: "drydock" | "conflicts",
    subId: string | undefined,
    requestEpoch: number,
  ): boolean {
    return !destroyed && opts.kind === kind && currentSubId === subId && requestEpoch === subRequestEpoch;
  }

  async function renderDrydockView(patchId: string | undefined): Promise<void> {
    if (destroyed) return;
    const requestEpoch = ++subRequestEpoch;
    currentSubId = patchId;
    staleKind = null;
    showLoading(readContainer, opts.tocContainer);
    opts.onTocChanged?.(0);
    cleanupReader();

    // 새 뷰 진입 시 결정 상태 초기화
    currentDetailMeta = null;
    currentDetailPatchId = null;
    renderedPatchStamp = null;
    decisionPhase = "idle";
    decisionError = null;
    detailDiffBlocks = null;
    detailProposedToc = "";
    detailProposedTocItems = [];
    diffMode = "changes";

    try {
      if (patchId) {
        const detail = await fetchDrydockDetail(liveOpts.theaterId, patchId);
        if (!isCurrentSubRequest("drydock", patchId, requestEpoch)) return;

        currentDetailMeta = detail.meta;
        currentDetailPatchId = patchId;
        renderedPatchStamp = patchStampOf(detail);

        // 대기 중인 update 패치는 현행 본문을 함께 읽어 "무엇이 바뀌는가"를 보여준다.
        // 결정된 패치·신규 문서·현행 조회 실패는 전문 렌더로 자연 강등된다.
        let currentBody: string | null = null;
        let currentVersion: number | null = null;
        if (detail.meta.status === "pending" && detail.patch.frontmatter.op === "update_wiki" && detail.targetExists) {
          try {
            const current = await fetchEntry(liveOpts.theaterId, detail.wikiEntry.id);
            if (!isCurrentSubRequest("drydock", patchId, requestEpoch)) return;
            currentBody = current.body;
            currentVersion = current.frontmatter.version;
          } catch {
            // diff는 향상이다 — 현행을 못 읽으면 전문 검토로 진행한다.
          }
        }

        const t = consoleT();
        const { html: markdownHtml, toc } = renderMarkdown(detail.wikiEntry.body, {
          omitDuplicateTitle: detail.wikiEntry.title,
          resolveWikiLink: (id) => entryPath(id),
          ...markdownCopyOptions(t),
        });
        detailProposedToc = renderTocSheet(toc);
        detailProposedTocItems = toc;
        detailDiffBlocks = currentBody !== null
          ? diffDraftBlocks(currentBody, detail.wikiEntry.body)
          : null;

        readContainer.innerHTML = renderPatchDetail(detail, markdownHtml, {
          currentVersion,
          diffBlocks: detailDiffBlocks,
          diffMode,
        });

        if (detailDiffBlocks) {
          // diff 진입은 항상 "변경만"으로 시작한다 — 아웃라인은 전문 토글이 채운다(redrawDiffBody).
          opts.tocContainer.innerHTML = "";
          opts.onTocChanged?.(0);
        } else {
          opts.tocContainer.innerHTML = detailProposedToc;
          opts.onTocChanged?.(detailProposedTocItems.length);
          const article = readContainer.querySelector<HTMLElement>("article");
          if (article && toc.length > 0) {
            cleanupSpy = installTocScrollSpy(article, toc, opts.tocContainer);
          }
        }
      } else {
        const status = queueSegment === "pending" ? "pending" : "archived";
        const list = await fetchDrydock(liveOpts.theaterId, status);
        if (!isCurrentSubRequest("drydock", patchId, requestEpoch)) return;
        opts.tocContainer.innerHTML = "";
        opts.onTocChanged?.(0);
        readContainer.innerHTML = renderDrydockList(list, queueSegment);
      }
    } catch (error) {
      if (isCurrentSubRequest("drydock", patchId, requestEpoch)) {
        showError(readContainer, opts.tocContainer, error);
      }
    }
  }

  async function renderConflictsView(conflictId: string | undefined): Promise<void> {
    if (destroyed) return;
    const requestEpoch = ++subRequestEpoch;
    currentSubId = conflictId;
    staleKind = null;
    showLoading(readContainer, opts.tocContainer);
    opts.onTocChanged?.(0);
    cleanupReader();

    try {
      if (conflictId) {
        const detail = await fetchConflictDetail(liveOpts.theaterId, conflictId);
        if (!isCurrentSubRequest("conflicts", conflictId, requestEpoch)) return;
        opts.tocContainer.innerHTML = "";
        opts.onTocChanged?.(0);
        readContainer.innerHTML = renderConflictDetail(detail);
      } else {
        const conflicts = await fetchConflicts(liveOpts.theaterId);
        if (!isCurrentSubRequest("conflicts", conflictId, requestEpoch)) return;
        opts.tocContainer.innerHTML = "";
        opts.onTocChanged?.(0);
        readContainer.innerHTML = renderConflictList(conflicts);
      }
    } catch (error) {
      if (isCurrentSubRequest("conflicts", conflictId, requestEpoch)) {
        showError(readContainer, opts.tocContainer, error);
      }
    }
  }

  async function renderSchemaView(templateId: string | undefined): Promise<void> {
    const requestEpoch = ++schemaRequestEpoch;
    const theaterId = liveOpts.theaterId;
    currentSubId = templateId;
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

  document.addEventListener(CODEX_LIVE_CHANGED_EVENT, handleLiveChanged);

  return {
    destroy(): void {
      destroyed = true;
      entryRequestEpoch += 1;
      subRequestEpoch += 1;
      schemaRequestEpoch += 1;
      readContainer.removeEventListener("click", handleClick);
      document.removeEventListener(CODEX_LIVE_CHANGED_EVENT, handleLiveChanged);
      linkPreview.destroy();
      cleanupReader();
      coworkController?.destroy();
    },
    async setEntry(entryId: string): Promise<void> {
      await renderEntryView(entryId);
    },
    async navigateSub(subId: string | undefined): Promise<void> {
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

function renderDrydockList(list: DrydockListResponse, segment: "pending" | "decided"): string {
  const t = consoleT();
  const items = list.items;
  const emptyLabel = segment === "pending" ? t("codex.reading.noPendingPatches") : t("codex.reading.noDecidedPatches");
  const rows = items.length === 0
    ? `<div class="codex-reader-empty"><p class="queue-empty">${escapeHtml(emptyLabel)}</p></div>`
    : `<div class="queue-row-list">${items.map(renderQueueRow).join("")}</div>`;
  // 유틸 화면 — 디스플레이 타이포 대신 title 스케일(.document--utility)로 강등한다.
  return `
    <article class="document document--utility">
      <header class="document-header">
        <nav class="breadcrumb" aria-label="${escapeAttribute(t("codex.reading.entryLocationAria"))}">
          <ol>
            <li><span>Codex</span></li>
            <li><span aria-current="page">${escapeHtml(t("codex.reading.reviewQueue"))}</span></li>
          </ol>
        </nav>
        <h1>${escapeHtml(t("codex.reading.reviewQueue"))}</h1>
        <div class="queue-segments" role="group" aria-label="${escapeAttribute(t("codex.reading.segmentAria"))}">
          <button type="button" data-queue-segment="pending" aria-pressed="${String(segment === "pending")}">${escapeHtml(t("codex.reading.segmentPending", { count: list.pendingCount }))}</button>
          <button type="button" data-queue-segment="decided" aria-pressed="${String(segment === "decided")}">${escapeHtml(t("codex.reading.segmentDecided", { count: list.archivedCount }))}</button>
        </div>
      </header>
      ${rows}
    </article>
  `;
}

function renderQueueRow(item: DrydockListItem): string {
  const t = consoleT();
  const op = item.op ?? "create_wiki";
  const glyph = OP_BADGE_GLYPHS[op] ?? "?";
  const label = opLabel(op, t);
  const target = item.target ?? item.id;
  const decidedAtMs = new Date(item.meta.decidedAt ?? "").getTime();
  const createdAtMs = new Date(item.meta.createdAt).getTime();
  const timeSource = item.meta.status === "pending" ? createdAtMs : (Number.isNaN(decidedAtMs) ? createdAtMs : decidedAtMs);
  const time = Number.isNaN(timeSource) ? "" : formatRelativeTime(timeSource, consoleLocale());
  const metaParts = [
    item.proposer ?? "",
    time,
  ].filter(Boolean);
  const diffstat = item.diffstat
    ? `<span class="queue-row-diffstat" aria-label="${escapeAttribute(t("codex.reading.diffStatAria", { added: item.diffstat.added, removed: item.diffstat.removed }))}"><ins>+${item.diffstat.added}</ins><del>\u2212${item.diffstat.removed}</del></span>`
    : "";
  const decided = item.meta.status !== "pending"
    ? `<span class="queue-row-decision queue-row-decision--${item.meta.status === "accepted" ? "approve" : "reject"}">${escapeHtml(item.meta.status === "accepted" ? t("codex.reading.approved") : t("codex.reading.rejected"))}</span>`
    : "";
  return `
    <button class="queue-row" type="button" data-patch-id="${escapeAttribute(item.id)}" aria-label="${escapeAttribute(label + ": " + target)}">
      <span class="queue-row-badge" aria-hidden="true">
        <span class="op-badge">${glyph}</span>
      </span>
      <span class="queue-row-body">
        <span class="queue-row-top">
          <span class="queue-row-target">${escapeHtml(target)}</span>
          ${diffstat}
          ${decided}
        </span>
        ${item.summary ? `<span class="queue-row-summary">${escapeHtml(item.summary)}</span>` : ""}
        ${metaParts.length > 0 ? `<span class="queue-row-meta">${metaParts.map(escapeHtml).join(" \u00b7 ")}</span>` : ""}
      </span>
    </button>
  `;
}

interface PatchDetailRenderOptions {
  readonly currentVersion: number | null;
  readonly diffBlocks: readonly DraftBlock[] | null;
  readonly diffMode: "changes" | "full";
}

function renderPatchDetail(detail: DrydockDetailResponse, markdownHtml: string, options: PatchDetailRenderOptions): string {
  const t = consoleT();
  const { patch, meta, wikiEntry, targetExists } = detail;
  const op = patch.frontmatter.op;
  const glyph = OP_BADGE_GLYPHS[op] ?? "?";
  const label = opLabel(op, t);
  const targetLabel = targetExists ? t("codex.reading.replaceExisting") : t("codex.reading.createNew");
  const isPending = meta.status === "pending";
  const versionLabel = options.currentVersion !== null
    ? `v${options.currentVersion} \u2192 v${wikiEntry.version}`
    : `v${wikiEntry.version}`;
  const diffstat = options.diffBlocks ? countDiffLines(options.diffBlocks) : null;
  const diffstatHtml = diffstat
    ? `<span class="queue-row-diffstat" aria-label="${escapeAttribute(t("codex.reading.diffStatAria", { added: diffstat.added, removed: diffstat.removed }))}"><ins>+${diffstat.added}</ins><del>\u2212${diffstat.removed}</del></span>`
    : "";
  const body = options.diffBlocks
    ? `
      <div class="queue-diff-controls" role="group" aria-label="${escapeAttribute(t("codex.reading.diffModeAria"))}">
        <button type="button" data-diff-mode="changes" aria-pressed="${String(options.diffMode === "changes")}">${escapeHtml(t("codex.reading.diffChanges"))}</button>
        <button type="button" data-diff-mode="full" aria-pressed="${String(options.diffMode === "full")}">${escapeHtml(t("codex.reading.diffFull"))}</button>
      </div>
      <div class="markdown-body" id="codex-reader-body" data-diff-body>
        ${renderDiffBlocks(options.diffBlocks, options.diffMode)}
      </div>`
    : `
      <div class="markdown-body" id="codex-reader-body">
        ${markdownHtml}
      </div>`;

  // 결정 독은 문서 위 스티키 — 근거(diff)와 결정 수단이 같은 화면에 머문다.
  return `
    <article class="document document--utility">
      <div class="queue-decision-dock">
        <div class="queue-decision-dock-copy">
          <span class="queue-decision-dock-title"><span class="op-badge" aria-label="${escapeAttribute(label)}">${glyph}</span> ${escapeHtml(wikiEntry.title)}</span>
          <span class="queue-decision-dock-meta">${escapeHtml(patch.frontmatter.target)} \u00b7 ${escapeHtml(versionLabel)} \u00b7 ${escapeHtml(targetLabel)}${patch.frontmatter.proposer ? ` \u00b7 ${escapeHtml(patch.frontmatter.proposer)}` : ""} ${diffstatHtml}</span>
        </div>
        <div class="queue-decision-dock-actions" data-decision-bar-wrap>
          ${isPending ? renderDecisionBarContent("idle", null) : renderDecidedState(meta)}
        </div>
      </div>
      <header class="document-header">
        <nav class="breadcrumb" aria-label="${escapeAttribute(t("codex.reading.entryLocationAria"))}">
          <ol>
            <li><span>Codex</span></li>
            <li><span>${escapeHtml(t("codex.reading.reviewQueue"))}</span></li>
            <li><span aria-current="page">${escapeHtml(label)}</span></li>
          </ol>
        </nav>
        <button type="button" class="queue-back-btn" data-drydock-action="back">${escapeHtml(t("codex.reading.backQueue"))}</button>
        ${renderPatchMetaChips(patch.frontmatter.proposer, wikiEntry.tags)}
      </header>
      ${body}
    </article>
  `;
}

function countDiffLines(blocks: readonly DraftBlock[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const block of blocks) {
    if (block.kind === "same") continue;
    const lines = block.markdown.split("\n").length;
    if (block.kind === "added") added += lines;
    else removed += lines;
  }
  return { added, removed };
}

// 렌더 문서 관점의 블록 diff — Cowork 리뷰와 같은 시각 관용구(cowork-block--*)를 쓴다.
// "변경만" 모드는 무변경 런을 접힘 표지로 축약해 검토 대상만 남긴다.
function renderDiffBlocks(blocks: readonly DraftBlock[], mode: "changes" | "full"): string {
  const t = consoleT();
  const renderBlock = (block: DraftBlock): string => {
    const html = renderMarkdown(block.markdown, {
      resolveWikiLink: (id) => entryPath(id),
      ...markdownCopyOptions(t),
    }).html;
    return block.kind === "same" ? html : `<div class="cowork-block cowork-block--${block.kind}">${html}</div>`;
  };
  if (mode === "full") return remapDiffHeadingIds(blocks.map(renderBlock).join(""));
  return blocks
    .map((block) => {
      if (block.kind !== "same") return renderBlock(block);
      const count = block.markdown.split(/\n{2,}/).filter(Boolean).length;
      return `<div class="queue-diff-fold" role="note">${escapeHtml(t("codex.reading.diffFold", { count }))}</div>`;
    })
    .join("");
}

// 블록별 renderMarkdown은 헤딩 ID 네임스페이스를 매번 새로 시작한다 — 제안 문서의
// 아웃라인(detailProposedToc)은 전문 1회 렌더 기준이므로, 삭제 블록의 헤딩 ID를 걷고
// 나머지(same+added = 제안 문서의 헤딩 순서 그대로)를 같은 슬러그·중복 규칙으로
// 재배정해 아웃라인 앵커가 제안 문서 헤딩에 정확히 닿게 한다.
function remapDiffHeadingIds(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  const usedIds = new Map<string, number>();
  for (const heading of document.body.querySelectorAll("h2, h3")) {
    if (heading.closest(".cowork-block--removed")) {
      heading.removeAttribute("id");
      continue;
    }
    const text = heading.textContent?.trim() ?? "";
    const baseId = slugifyHeading(text || "section");
    const count = usedIds.get(baseId) ?? 0;
    usedIds.set(baseId, count + 1);
    heading.id = count === 0 ? baseId : `${baseId}-${count + 1}`;
  }
  return document.body.innerHTML;
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
        <button type="button" class="queue-back-btn" data-conflict-action="back" aria-label="${escapeAttribute(t("codex.reading.backConflicts"))}">${escapeHtml(t("codex.reading.backConflicts"))}</button>
        <h1>${escapeHtml(detail.id)}</h1>
        <p class="eyebrow">${escapeHtml(t("codex.reading.conflictEyebrow", { status }))}</p>
      </header>
      <div class="markdown-body">
        ${renderConflictComparison(detail, t)}
      </div>
    </article>
  `;
}

// current·proposed가 모두 있으면 블록 diff로 "어디가 갈라졌는가"를 직접 보여준다.
// 한쪽만 있으면 기존 전문 나열로 강등한다.
function renderConflictComparison(detail: ConflictDetailResponse, t: T): string {
  if (detail.current && detail.proposed) {
    const legend = `
      <div class="queue-diff-legend" aria-hidden="true">
        <span class="queue-diff-legend-item queue-diff-legend-item--added">${escapeHtml(t("codex.reading.proposed"))}</span>
        <span class="queue-diff-legend-item queue-diff-legend-item--removed">${escapeHtml(t("codex.reading.current"))}</span>
      </div>`;
    const blocks = diffDraftBlocks(detail.current, detail.proposed);
    return legend + renderDiffBlocks(blocks, "full");
  }
  const sections: string[] = [];
  if (detail.current) sections.push(`<h2>${escapeHtml(t("codex.reading.current"))}</h2><pre><code>${escapeHtml(detail.current)}</code></pre>`);
  if (detail.proposed) sections.push(`<h2>${escapeHtml(t("codex.reading.proposed"))}</h2><pre><code>${escapeHtml(detail.proposed)}</code></pre>`);
  return sections.join("");
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
