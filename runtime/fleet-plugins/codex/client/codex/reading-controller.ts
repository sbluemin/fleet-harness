import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import { renderMarkdown, slugifyHeading } from "@fleet-console/markdown/core";
import type { TocItem } from "@fleet-console/markdown/core";
import { diffDraftBlocks } from "@fleet-console/markdown/diff";
import type { DraftBlock } from "@fleet-console/markdown/diff";
import type { Translate } from "@fleet-console/sdk/i18n";
import type { ClientNavigateCapability } from "@fleet-console/sdk/navigation";
import { mountCodexFileLinks, resolveCodexFileLink } from "./file-links.js";

import { diagramHydratorLabels, formatRelativeTime, getT, markdownCopyOptions, type CoreMessageKey } from "../i18n/index.js";
import { resolveActiveLocale } from "../i18n/index.js";
import {
  CodexRequestError,
  decideDrydock,
  decideDrydockBatch,
  decideConflict,
  fetchConflictDetail,
  fetchConflicts,
  fetchDrydock,
  fetchDrydockDetail,
  fetchEntry,
  fetchSchemaDocument,
  stageEntryDeletion,
} from "./api.js";
import type {
  ConflictDetailResponse,
  ConflictListItem,
  DrydockBaseConflict,
  DrydockDetailResponse,
  DrydockListItem,
  DrydockListResponse,
  DrydockMeta,
  EntryBacklink,
  EntryResponse,
} from "./api.js";
import { installEntryLinkPreview } from "./components/link-preview.js";
import type { EntryLinkPreview } from "./components/link-preview.js";
import { renderMetaChips, renderTagChips } from "./components/meta-chips.js";
import { installTocScrollSpy, renderTocSheet } from "./components/toc-sheet.js";
import { mountCoworkInline } from "./cowork-controller.js";
import type { CoworkController } from "./cowork-controller.js";
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
  refreshCallbacks(next: Partial<Pick<MountReadingOptions, "onPatchOpen" | "onConflictOpen" | "onDecided" | "onRelatedClick" | "onClose" | "onTagClick" | "theaterId" | "fileTheaterId" | "navigate">>): void;
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
  readonly kind: "entry" | "drydock" | "conflicts" | "schema";
  readonly subId?: string;
  readonly theaterId: string | null;
  readonly fileTheaterId?: string | null;
  readonly navigate?: ClientNavigateCapability;
  readonly onRelatedClick: (id: string) => void;
  readonly onClose: () => void;
  /** 패치 행 클릭(상세 진입) 또는 뒤로가기(undefined) 콜백 */
  readonly onPatchOpen?: (patchId: string | undefined) => void;
  readonly onConflictOpen?: (conflictId: string | undefined) => void;
  /** 승인/반려 결정 완료 후 목록 갱신을 트리거하는 콜백 */
  readonly onDecided?: (kind?: "drydock" | "conflicts") => void;
  /** 문서 헤더 태그 칩 클릭 — 카탈로그 태그 필터로 라우팅된다. */
  readonly onTagClick?: (tag: string) => void;
  readonly onEntryRendered?: (entryId: string) => void;
  readonly onTocChanged?: (count: number) => void;
  readonly tocContainer: HTMLElement;
  /** Cowork 도크가 정박할 프레임 경계 슬롯(스크롤포트 밖). */
  readonly dockContainer?: HTMLElement;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OP_BADGE_GLYPHS: Record<string, string> = { create_wiki: "+", update_wiki: "↻", delete_wiki: "−" };

function opLabel(op: string, t: T): string {
  if (op === "create_wiki") return t("codex.reading.opCreate");
  if (op === "update_wiki") return t("codex.reading.opUpdate");
  if (op === "delete_wiki") return t("codex.reading.opDelete");
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
  // 재부착에 필요한 마지막 설치 인자 — relocate 후 같은 문서 위에 스파이를 다시 세운다.
  let spyContext: { article: HTMLElement; items: TocItem[] } | null = null;
  let currentDocument: ReaderDocument | null = null;
  let coworkController: CoworkController | null = null;
  // relocate(split↔overlay) 시 현재 마운트 소유자의 콜백이 반영되도록 가변 참조로 유지
  let liveOpts = opts;
  const fileLinks = mountCodexFileLinks({
    container: readContainer,
    secondaryContainer: opts.dockContainer,
    getTheaterId: () => liveOpts.fileTheaterId ?? liveOpts.theaterId,
    getNavigate: () => liveOpts.navigate,
  });
  let currentEntryId = opts.kind === "entry" ? opts.initialEntryId : "";
  let currentSubId = opts.subId;

  // 드라이독 결정 상태 (패치 상세 뷰에서 관리)
  type DecisionPhase = "idle" | "approving" | "rejecting" | "submitting";
  let decisionPhase: DecisionPhase = "idle";
  let decisionError: string | null = null;
  let approvalBlocked: string | null = null;
  let currentDetailMeta: DrydockMeta | null = null;
  let currentDetailPatchId: string | null = null;
  // 대기열 세그먼트·diff 표시 상태 — 목록은 pending/결정됨을 오가고,
  // update 패치 상세는 "변경만"이 기본이다(전문은 토글).
  let queueSegment: "pending" | "decided" = "pending";
  let queueList: DrydockListResponse | null = null;
  const queueSelected = new Set<string>();
  let batchAction: "approve" | "reject" | null = null;
  let batchBusy = false;
  let batchReason = "";
  let batchNotice = "";
  let batchProblems: Array<{ label: string; conflictId?: string }> = [];
  let diffMode: "changes" | "full" = "changes";
  let detailDiffBlocks: readonly DraftBlock[] | null = null;
  let detailProposedToc = "";
  let detailProposedTocItems: readonly TocItem[] = [];
  // 읽는 중인 문서가 서버에서 바뀌었다는 사실. 본문은 그대로 두고 이 표식만 띄운다.
  let staleKind: "updated" | "decided" | "deleted" | null = null;
  // 지금 화면에 그려진 문서의 갱신 시각. 카탈로그의 같은 값과 어긋나면 이 문서가 바뀐 것이다.
  let renderedEntryStamp: string | null = null;
  // 지금 화면에 그려진 패치의 판본. 대기열에서 *다른* 패치가 움직인 것으로는 이 값이 변하지 않는다.
  let renderedPatchStamp: string | null = null;
  // 같은 이유로 충돌·스키마 문서도 자기 판본을 들고 있어야 한다 — 범위 이벤트는 어느 문서가
  // 바뀌었는지 말해 주지 않으므로, 비교 없이 알리면 옆 문서의 변화가 이 문서의 표식이 된다.
  let renderedConflictStamp: string | null = null;
  let currentConflict: ConflictDetailResponse | null = null;
  let conflictAction: "reject" | "repropose" | "resolve" | null = null;
  let conflictBusy = false;
  let conflictError: string | null = null;
  let conflictNote = "";
  let pendingRequestEpoch = 0;
  let renderedSchemaStamp: string | null = null;

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

    const deleteButton = target.closest<HTMLButtonElement>("[data-entry-stage-delete]");
    if (deleteButton && currentEntryId) {
      event.preventDefault();
      if (staleKind === "deleted") return;
      const entryId = currentEntryId, theaterId = liveOpts.theaterId, epoch = entryRequestEpoch;
      const errorLabel = readContainer.querySelector<HTMLElement>("[data-entry-delete-error]");
      if (errorLabel) errorLabel.textContent = "";
      deleteButton.disabled = true;
      void stageEntryDeletion(theaterId, entryId).then(({ patchId }) => {
        if (!destroyed && epoch === entryRequestEpoch && entryId === currentEntryId && theaterId === liveOpts.theaterId) liveOpts.onPatchOpen?.(patchId);
      }).catch((error: unknown) => {
        if (destroyed || epoch !== entryRequestEpoch || entryId !== currentEntryId || theaterId !== liveOpts.theaterId) return;
        if (error instanceof CodexRequestError && error.status === 404) showStaleNotice("deleted");
        else deleteButton.disabled = false;
        if (errorLabel) errorLabel.textContent = patchActionMessage(error instanceof CodexRequestError ? error.code : "", "codex.reading.deleteActionFailed");
      });
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

    const select = target.closest<HTMLInputElement>("input[data-queue-select]");
    if (select) {
      if (select.checked && queueSelected.size >= 100) { select.checked = false; batchNotice = consoleT()("codex.reading.batchLimit"); }
      else if (select.checked) queueSelected.add(select.dataset.queueSelect!);
      else queueSelected.delete(select.dataset.queueSelect!);
      redrawBatchControls();
      return;
    }
    const batch = target.closest<HTMLElement>("[data-batch-action]");
    if (batch) { event.preventDefault(); handleBatchAction(batch.dataset.batchAction); return; }

    // 대기열 세그먼트 전환 (대기 ↔ 결정됨)
    const segmentBtn = target.closest<HTMLElement>("[data-queue-segment]");
    if (segmentBtn) {
      event.preventDefault();
      const next = segmentBtn.dataset.queueSegment === "decided" ? "decided" : "pending";
      if (batchBusy) return;
      if (next !== queueSegment) {
        batchAction = null;
        queueSelected.clear();
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

    const conflictPanelTab = target.closest<HTMLElement>("[data-conflict-panel-tab]");
    if (conflictPanelTab) { event.preventDefault(); selectConflictPanel(conflictPanelTab.dataset.conflictPanelTab); return; }
    const conflictActionBtn = target.closest<HTMLElement>("[data-conflict-action]");
    if (conflictActionBtn) {
      event.preventDefault();
      if (conflictActionBtn.dataset.conflictAction === "back") liveOpts.onConflictOpen?.(undefined);
      else handleConflictAction(conflictActionBtn.dataset.conflictAction);
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

  function batchState(): QueueBatchState {
    return { selected: queueSelected, action: batchAction, busy: batchBusy, reason: batchReason, notice: batchNotice, problems: batchProblems };
  }

  function redrawBatchControls(): void {
    const slot = readContainer.querySelector<HTMLElement>("[data-batch-controls]");
    if (slot && queueList) slot.innerHTML = renderBatchControls(queueList.items, batchState());
  }

  function redrawQueueList(): void {
    if (!queueList) return;
    readContainer.innerHTML = renderDrydockList(queueList, queueSegment, batchState());
  }

  function handleBatchAction(action: string | undefined): void {
    if (!queueList || currentSubId || queueSegment !== "pending" || batchBusy) return;
    if (action === "select" || action === "clear") {
      queueSelected.clear();
      if (action === "select") for (const item of queueList.items.filter(item => item.meta.status === "pending").slice(0, 100)) queueSelected.add(item.id);
      batchAction = null;
      redrawQueueList();
      readContainer.querySelector<HTMLButtonElement>(`[data-batch-action=${action}]`)?.focus({ preventScroll: true });
      return;
    }
    if (action === "cancel") { batchAction = null; redrawQueueList(); return; }
    const chosen = queueList.items.filter(item => queueSelected.has(item.id) && item.meta.status === "pending");
    if (action === "approve" || action === "reject") {
      if (!chosen.length || action === "approve" && !chosen.some(item => !item.baseConflict)) return;
      batchAction = action;
      batchNotice = "";
      batchProblems = [];
      redrawQueueList();
      readContainer.querySelector<HTMLElement>(action === "reject" ? "[data-batch-reason]" : "[data-batch-action=confirm]")?.focus({ preventScroll: true });
      return;
    }
    if (action !== "confirm" || !batchAction) return;
    if (batchAction === "reject" && !batchReason.trim()) { batchNotice = consoleT()("codex.reading.rejectReasonRequired"); redrawBatchControls(); return; }
    const selectedAction = batchAction, ids = chosen.map(item => item.id), theaterId = liveOpts.theaterId, epoch = subRequestEpoch;
    batchBusy = true;
    redrawQueueList();
    void decideDrydockBatch(theaterId, ids, selectedAction, batchReason.trim()).then(async result => {
      if (!isCurrentSubRequest("drydock", undefined, epoch) || theaterId !== liveOpts.theaterId) return;
      const decided = result.results.filter(item => item.outcome === "approved" || item.outcome === "rejected");
      for (const item of decided) queueSelected.delete(item.id);
      batchNotice = consoleT()("codex.reading.batchResult", { decided: decided.length, skipped: result.results.filter(item => item.outcome === "skipped").length, failed: result.results.filter(item => item.outcome === "failed").length });
      batchProblems = result.results.filter(item => item.outcome === "skipped" || item.outcome === "failed").map(item => {
        const proposal = chosen.find(candidate => candidate.id === item.id);
        const name = proposal ? `${proposal.target ?? proposal.id} · ${localizedQueueSummary(proposal, consoleT())}` : item.id;
        return { label: `${name}: ${patchActionMessage(item.error ?? "", item.outcome === "skipped" ? "codex.reading.batchSkipped" : "codex.reading.batchFailed")}`, conflictId: item.conflictId };
      });
      batchBusy = false;
      batchAction = null;
      // 목록 소유자는 유지한다. 단건용 onDecided는 navigation까지 수행하므로 여기서 호출하지 않는다.
      await renderDrydockView(undefined);
    }).catch(() => {
      if (!isCurrentSubRequest("drydock", undefined, epoch)) return;
      batchNotice = consoleT()("codex.reading.batchFailed");
      batchBusy = false;
      redrawQueueList();
    }).finally(() => { batchBusy = false; });
  }

  function selectConflictPanel(panel: string | undefined): void {
    if (!panel || !["base", "current", "proposed"].includes(panel)) return;
    const comparison = readContainer.querySelector<HTMLElement>(".conflict-comparison");
    if (!comparison) return;
    comparison.dataset.activePanel = panel;
    readContainer.querySelectorAll<HTMLButtonElement>("[data-conflict-panel-tab]").forEach(tab => { const active = tab.dataset.conflictPanelTab === panel; tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1; });
  }

  function handleComparisonKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !(event.target instanceof Element)) return;
    const tab = event.target.closest<HTMLButtonElement>("[data-conflict-panel-tab]");
    if (!tab) return;
    const tabs = Array.from(readContainer.querySelectorAll<HTMLButtonElement>("[data-conflict-panel-tab]"));
    const index = tabs.indexOf(tab);
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); event.stopPropagation();
    selectConflictPanel(tabs[next]!.dataset.conflictPanelTab);
    tabs[next]!.focus({ preventScroll: true });
  }

  function handleBatchInput(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement && target.hasAttribute("data-batch-reason")) batchReason = target.value;
  }

  function redrawConflictControls(): void {
    const area = readContainer.querySelector<HTMLElement>("[data-conflict-controls]");
    if (area && currentConflict) area.innerHTML = renderConflictControls(currentConflict, conflictAction, conflictBusy, conflictError, conflictNote);
  }

  function handleConflictAction(action: string | undefined): void {
    if (!currentConflict || conflictBusy) return;
    conflictNote = readContainer.querySelector<HTMLTextAreaElement>("[data-conflict-note]")?.value ?? conflictNote;
    conflictError = null;
    if (action === "cancel") { conflictAction = null; redrawConflictControls(); return; }
    if (action === "reject" || action === "repropose" || action === "resolve") {
      if (action === "repropose" && !currentConflict.canRepropose) return;
      conflictAction = action;
      redrawConflictControls();
      readContainer.querySelector<HTMLTextAreaElement>("[data-conflict-note]")?.focus({ preventScroll: true });
      return;
    }
    if (action !== "confirm" || !conflictAction) return;
    if (!conflictNote.trim()) {
      conflictError = consoleT()(conflictAction === "reject" ? "codex.reading.rejectReasonRequired" : conflictAction === "repropose" ? "codex.reading.reproposeReasonRequired" : "codex.reading.resolveReasonRequired");
      redrawConflictControls();
      return;
    }
    const detail = currentConflict, selected = conflictAction, theaterId = liveOpts.theaterId;
    const epoch = subRequestEpoch;
    conflictBusy = true;
    redrawConflictControls();
    void decideConflict(theaterId, detail.id, selected, conflictNote.trim(), detail.currentHash).then(async result => {
      if (!isCurrentSubRequest("conflicts", detail.id, epoch) || theaterId !== liveOpts.theaterId) return;
      liveOpts.onDecided?.("conflicts");
      if (result.patchId) liveOpts.onPatchOpen?.(result.patchId);
      else await renderConflictsView(detail.id);
    }).catch(() => {
      if (!isCurrentSubRequest("conflicts", detail.id, epoch)) return;
      conflictError = consoleT()("codex.reading.conflictFailed");
    }).finally(() => { if (isCurrentSubRequest("conflicts", detail.id, epoch)) { conflictBusy = false; redrawConflictControls(); } });
  }

  function handleDrydockAction(action: string | undefined): void {
    if (!action) return;

    if (action === "back") {
      liveOpts.onPatchOpen?.(undefined);
      return;
    }

    if (decisionPhase === "submitting") return;
    if ((action === "approve" || action === "approve-confirm") && approvalBlocked) return;

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
    const patchId = currentDetailPatchId;
    const theaterId = liveOpts.theaterId;
    const requestEpoch = subRequestEpoch;
    decisionPhase = "submitting";
    decisionError = null;
    redrawDecisionBar();
    try {
      await decideDrydock(theaterId, patchId, action, reason);
      if (!isCurrentSubRequest("drydock", patchId, requestEpoch) || liveOpts.theaterId !== theaterId) return;
      liveOpts.onDecided?.();
    } catch (err) {
      if (!isCurrentSubRequest("drydock", patchId, requestEpoch) || liveOpts.theaterId !== theaterId) return;
      if (err instanceof CodexRequestError && err.code === "stale_base") {
        approvalBlocked = patchBaseConflictMessage(err.baseConflict);
        const version = readContainer.querySelector<HTMLElement>("[data-patch-version]");
        if (version && err.baseConflict) version.textContent = stalePatchVersionLabel(err.baseConflict);
        decisionPhase = "idle";
      } else {
        decisionPhase = action === "approve" ? "approving" : "rejecting";
        decisionError = err instanceof Error ? err.message : String(err);
      }
      redrawDecisionBar();
    }
  }

  function redrawDecisionBar(): void {
    const wrap = readContainer.querySelector<HTMLElement>("[data-decision-bar-wrap]");
    if (!wrap) return;
    wrap.innerHTML = renderDecisionBarContent(decisionPhase, decisionError, approvalBlocked);
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
        installSpy(article, [...detailProposedTocItems]);
      }
    } else {
      opts.tocContainer.innerHTML = "";
      opts.onTocChanged?.(0);
    }
  }

  readContainer.addEventListener("click", handleClick);
  readContainer.addEventListener("input", handleBatchInput);
  readContainer.addEventListener("keydown", handleComparisonKeyDown);

  function installSpy(article: HTMLElement, items: TocItem[]): void {
    cleanupSpy?.();
    spyContext = { article, items };
    cleanupSpy = installTocScrollSpy(article, items, opts.tocContainer);
  }

  function cleanupReader(): void {
    fileLinks.close();
    coworkController?.destroy();
    coworkController = null;
    cleanupSpy?.();
    cleanupSpy = null;
    spyContext = null;
    if (currentDocument !== null) {
      currentDocument = null;
      // 드라이독·충돌·스키마로 넘어가거나 다음 문서를 못 읽어 온 순간부터 이전 문서는
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
      if (scopes.has("queue")) void refreshPendingCount(currentEntryId);
      if (!scopes.has("wiki") && !scopes.has("index")) return;
      void coworkController?.refresh();
      // updated 필드가 그대로인 외부 편집과 카탈로그에서 빠진 삭제도 실제 API로 확인한다.
      void noticeForOpenEntry(currentEntryId);
      return;
    }
    if (opts.kind === "drydock") {
      if (!scopes.has("queue")) return;
      if (!currentSubId) {
        if (batchBusy) return;
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
      void noticeForOpenConflict(currentSubId);
      return;
    }
    if (opts.kind === "schema") {
      if (!scopes.has("schema")) return;
      // 워크스페이스 스키마(subId 없음)도 목록이 아니라 읽는 문서다 — 대기열·충돌 목록과
      // 달리 말없이 갈아끼우면 읽던 자리를 잃는다.
      void noticeForOpenSchema(currentSubId);
    }
  }

  /**
   * 읽던 제안이 밖에서 승인·반려됐다면 그렇게 말해야 한다 — "갱신됐다"로 뭉뚱그리면
   * 사용자는 아직 자기가 결정할 수 있다고 믿은 채 승인 버튼을 누르러 간다.
   */
  async function refreshPendingCount(entryId: string): Promise<void> {
    const epoch = ++pendingRequestEpoch;
    const entryEpoch = entryRequestEpoch;
    const theaterId = liveOpts.theaterId;
    try {
      const entry = await fetchEntry(theaterId, entryId);
      if (destroyed || entryEpoch !== entryRequestEpoch || epoch !== pendingRequestEpoch || entryId !== currentEntryId || theaterId !== liveOpts.theaterId) return;
      const slot = readContainer.querySelector<HTMLElement>("[data-entry-pending]");
      if (slot) slot.innerHTML = pendingPatchLabel(entry.pendingPatchCount ?? 0);
    } catch { /* 조회 실패는 0건이라는 사실이 아니다. 기존 표식을 유지한다. */ }
  }

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

  async function noticeForOpenConflict(conflictId: string): Promise<void> {
    try {
      const detail = await fetchConflictDetail(liveOpts.theaterId, conflictId);
      if (destroyed || currentSubId !== conflictId) return;
      const stamp = JSON.stringify(detail);
      if (renderedConflictStamp === null) {
        renderedConflictStamp = stamp;
        return;
      }
      if (stamp === renderedConflictStamp) return;
      showStaleNotice("updated");
    } catch {
      // 조회가 실패했다면 무엇이 달라졌는지 알 수 없다 — 근거 없는 알림은 띄우지 않는다.
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

  /** 이 패치의 판본 — 결정 상태와 제안 본문이 함께 움직여야 다른 판본이다. */
  function patchStampOf(detail: DrydockDetailResponse): string {
    return `${detail.meta.status}:${detail.meta.decidedAt ?? ""}:${detail.patch.body.length}:${detail.patch.body}`;
  }

  function entryStampOf(entry: EntryResponse): string { return JSON.stringify([entry.frontmatter, entry.body]); }

  async function noticeForOpenEntry(entryId: string): Promise<void> {
    const epoch = entryRequestEpoch, theaterId = liveOpts.theaterId;
    try {
      const entry = await fetchEntry(theaterId, entryId);
      if (destroyed || epoch !== entryRequestEpoch || entryId !== currentEntryId || theaterId !== liveOpts.theaterId) return;
      if (!coworkController?.engaged() && renderedEntryStamp !== null && entryStampOf(entry) !== renderedEntryStamp) showStaleNotice("updated");
    } catch (error) {
      if (!destroyed && epoch === entryRequestEpoch && entryId === currentEntryId && theaterId === liveOpts.theaterId && error instanceof CodexRequestError && error.status === 404) showStaleNotice("deleted");
    }
  }

  function showStaleNotice(kind: "updated" | "decided" | "deleted"): void {
    // 결정 사실은 단순 갱신보다 강한 소식이다 — 한 번 켜지면 갱신 문구로 내려가지 않는다.
    if ((staleKind === "decided" || staleKind === "deleted") && kind === "updated") return;
    staleKind = kind;
    if (kind === "deleted") {
      readContainer.querySelector<HTMLButtonElement>("[data-entry-stage-delete]")?.setAttribute("disabled", "");
      coworkController?.setWriteBlocked(true);
    }
    const t = consoleT();
    const label = kind === "deleted" ? t("codex.reading.staleDeleted") : kind === "decided" ? t("codex.reading.staleDecided") : t("codex.reading.staleUpdated");
    const action = kind === "deleted" ? t("common.close") : kind === "decided" ? t("codex.reading.staleSeeResult") : t("codex.reading.staleReload");
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
            <div data-entry-pending role="status">${pendingPatchLabel(entry.pendingPatchCount ?? 0)}</div>
            <button type="button" class="queue-back-btn" data-entry-stage-delete>${escapeHtml(t("codex.reading.proposeDelete"))}</button>
            <span data-entry-delete-error role="alert"></span>
          </header>
          <div class="markdown-body" id="codex-reader-body">
            ${markdownHtml}
          </div>
          ${relatedHtml}
          ${backlinksHtml}
        </article>
      `;

      currentDocument = { entryId, title: entry.frontmatter.title, markdown: entry.body };
      opts.tocContainer.innerHTML = renderTocSheet(toc);
      opts.onTocChanged?.(toc.length);
      const article = readContainer.querySelector<HTMLElement>("article");
      if (article && toc.length > 0) {
        installSpy(article, toc);
      }
      // 별도 화면 전환 없이 리딩 뷰 자체를 Cowork로 증강한다(드래그 → Comment → 도크).
      const body = readContainer.querySelector<HTMLElement>("#codex-reader-body");
      if (body) void fileLinks.enhanceInlinePaths(body);
      if (article && body) {
        coworkController = mountCoworkInline({
          theaterId: liveOpts.theaterId,
          entryId,
          title: entry.frontmatter.title,
          article,
          body,
          dockHost: opts.dockContainer,
          onApplied: () => { void renderEntryView(entryId); },
          onBodyRendered: () => { void fileLinks.enhanceInlinePaths(body); },
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
    approvalBlocked = null;
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
        approvalBlocked = detail.baseConflict ? patchBaseConflictMessage(detail.baseConflict) : null;
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
          resolveLink: resolveCodexFileLink,
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
            installSpy(article, toc);
          }
        }
      } else {
        const status = queueSegment === "pending" ? "pending" : "archived";
        const list = await fetchDrydock(liveOpts.theaterId, status);
        if (!isCurrentSubRequest("drydock", patchId, requestEpoch)) return;
        opts.tocContainer.innerHTML = "";
        opts.onTocChanged?.(0);
        queueList = list;
        for (const id of queueSelected) if (!list.items.some(item => item.id === id && item.meta.status === "pending")) queueSelected.delete(id);
        readContainer.innerHTML = renderDrydockList(list, queueSegment, batchState());
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
    currentConflict = null;
    conflictAction = null;
    conflictBusy = false;
    conflictError = null;
    conflictNote = "";
    staleKind = null;
    renderedConflictStamp = null;
    showLoading(readContainer, opts.tocContainer);
    opts.onTocChanged?.(0);
    cleanupReader();

    try {
      if (conflictId) {
        const detail = await fetchConflictDetail(liveOpts.theaterId, conflictId);
        if (!isCurrentSubRequest("conflicts", conflictId, requestEpoch)) return;
        opts.tocContainer.innerHTML = "";
        opts.onTocChanged?.(0);
        currentConflict = detail;
        readContainer.innerHTML = renderConflictDetail(detail);
        redrawConflictControls();
        renderedConflictStamp = JSON.stringify(detail);
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
      readContainer.innerHTML = `<article class="document"><header class="document-header"><nav class="breadcrumb"><ol><li><span>Codex</span></li><li><span>${escapeHtml(t("codex.reading.schema"))}</span></li><li><span aria-current="page">${escapeHtml(schemaLabel)}</span></li></ol></nav><h1>${escapeHtml(schemaLabel)}</h1><span class="queue-dl-mono">${escapeHtml(document.ref)}</span></header><div class="markdown-body" id="codex-reader-body">${html}</div></article>`;
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
      readContainer.removeEventListener("input", handleBatchInput);
      readContainer.removeEventListener("keydown", handleComparisonKeyDown);
      document.removeEventListener(CODEX_LIVE_CHANGED_EVENT, handleLiveChanged);
      linkPreview.destroy();
      fileLinks.destroy();
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

function patchActionMessage(code: string, fallback: CoreMessageKey): string {
  const t = consoleT();
  switch (code) {
    case "create_target_exists": return t("codex.reading.createTargetExists");
    case "update_target_missing": case "delete_target_missing": case "entry_not_found": case "not_found": return t("codex.reading.entryUnavailable");
    case "invalid_patch": return t("codex.reading.invalidProposal");
    case "patch_busy": return t("codex.reading.patchBusy");
    case "patch_not_pending": case "patch_not_found": return t("codex.reading.patchNotPending");
    case "stale_base": return t("codex.reading.staleBadge");
    default: return t(fallback);
  }
}

function showError(readContainer: HTMLElement, tocContainer: HTMLElement, error: unknown): void {
  const message = error instanceof CodexRequestError ? patchActionMessage(error.code, "codex.reading.requestFailed") : error instanceof Error ? error.message : String(error);
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

interface QueueBatchState {
  selected: ReadonlySet<string>;
  action: "approve" | "reject" | null;
  busy: boolean;
  reason: string;
  notice: string;
  problems: readonly { label: string; conflictId?: string }[];
}

function renderBatchControls(items: readonly DrydockListItem[], state: QueueBatchState): string {
  const t = consoleT();
  const selected = items.filter(item => state.selected.has(item.id));
  const stale = selected.filter(item => !!item.baseConflict).length;
  const status = state.notice ? `<p role="status">${escapeHtml(state.notice)}</p>${state.problems.length ? `<ul>${state.problems.map(problem => `<li>${escapeHtml(problem.label)}${problem.conflictId ? ` <button type="button" class="queue-action-btn" data-conflict-id="${escapeAttribute(problem.conflictId)}">${escapeHtml(t("codex.reading.reviewConflict"))}</button>` : ""}</li>`).join("")}</ul>` : ""}` : "";
  if (state.busy) return `<p role="status" aria-busy="true">${escapeHtml(t("codex.reading.processingAria"))}</p>`;
  const count = state.action === "approve" ? selected.length - stale : selected.length;
  if (state.action) return `${status}<p>${escapeHtml(t(state.action === "approve" ? "codex.reading.batchApproveConfirm" : "codex.reading.batchRejectConfirm", { count, skipped: stale }))}</p>
    ${state.action === "reject" ? `<textarea data-batch-reason maxlength="256" rows="3" aria-label="${escapeAttribute(t("codex.reading.rejectPlaceholder"))}" placeholder="${escapeAttribute(t("codex.reading.rejectPlaceholder"))}">${escapeHtml(state.reason)}</textarea>` : ""}
    <div class="queue-action-buttons"><button type="button" data-batch-action="confirm" class="queue-action-btn"${count === 0 ? " disabled" : ""}>${escapeHtml(t("codex.reading.batchConfirm"))}</button><button type="button" data-batch-action="cancel" class="queue-action-btn">${escapeHtml(t("common.cancel"))}</button></div>`;
  return `${status}<p>${escapeHtml(t("codex.reading.batchSelection", { count: selected.length, skipped: stale }))}</p>
    <div class="queue-action-buttons"><button type="button" data-batch-action="select" class="queue-action-btn">${escapeHtml(t("codex.reading.batchSelect"))}</button><button type="button" data-batch-action="clear" class="queue-action-btn"${!selected.length ? " disabled" : ""}>${escapeHtml(t("codex.reading.batchClear"))}</button>
    <button type="button" data-batch-action="approve" class="queue-action-btn"${selected.length === stale ? " disabled" : ""}>${escapeHtml(t("codex.reading.batchApprove"))}</button><button type="button" data-batch-action="reject" class="queue-action-btn"${!selected.length ? " disabled" : ""}>${escapeHtml(t("codex.reading.batchReject"))}</button></div>`;
}

function renderDrydockList(list: DrydockListResponse, segment: "pending" | "decided", batch: QueueBatchState): string {
  const t = consoleT();
  const items = list.items;
  const emptyLabel = segment === "pending" ? t("codex.reading.noPendingPatches") : t("codex.reading.noDecidedPatches");
  const rows = items.length === 0
    ? `<div class="codex-reader-empty"><p class="queue-empty">${escapeHtml(emptyLabel)}</p></div>`
    : `<div class="queue-row-list">${items.map(item => segment === "pending" ? `<div class="queue-selection-row"><input type="checkbox" data-queue-select="${escapeAttribute(item.id)}" aria-label="${escapeAttribute(t("codex.reading.batchSelectItem", { name: item.target ?? item.summary ?? item.id }))}"${batch.selected.has(item.id) ? " checked" : ""}${batch.busy || batch.action ? " disabled" : ""}>${renderQueueRow(item)}</div>` : renderQueueRow(item)).join("")}</div>`;
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
      ${segment === "pending" ? `<section class="queue-batch-controls" data-batch-controls aria-label="${escapeAttribute(t("codex.reading.batchReview"))}">${renderBatchControls(items, batch)}</section>` : ""}
      ${rows}
    </article>
  `;
}

function localizedQueueSummary(item: DrydockListItem, t: T): string {
  const summary = item.summary ?? "";
  const id = item.target?.split("/").at(-1)?.replace(/\.md$/u, "");
  if (id && item.op === "delete_wiki" && summary === `Delete ${id}`.slice(0, 120)) {
    return t("codex.reading.deleteProposalSummary");
  }
  if (id && item.proposer === "codex-cowork" && summary === `Cowork update ${id}`) {
    return t("codex.reading.coworkProposalSummary");
  }
  if (item.proposer === "tool:wiki_compile_source") {
    if (summary.startsWith("Compile source page ")) return t("codex.reading.compileSourceSummary", { title: summary.slice("Compile source page ".length) });
    if (summary.startsWith("Compile note for ")) return t("codex.reading.compileNoteSummary", { title: summary.slice("Compile note for ".length) });
  }
  // 사용자가 쓴 요약과 콘텐츠 제목은 번역하거나 가리지 않는다.
  return summary;
}

function renderQueueRow(item: DrydockListItem): string {
  const t = consoleT();
  const op = item.op ?? "create_wiki";
  const glyph = OP_BADGE_GLYPHS[op] ?? "?";
  const label = opLabel(op, t);
  const target = item.target ?? item.id;
  const summary = localizedQueueSummary(item, t);
  const decidedAtMs = new Date(item.meta.decidedAt ?? "").getTime();
  const createdAtMs = new Date(item.meta.createdAt).getTime();
  const timeSource = item.meta.status === "pending" ? createdAtMs : (Number.isNaN(decidedAtMs) ? createdAtMs : decidedAtMs);
  const time = Number.isNaN(timeSource) ? "" : formatRelativeTime(timeSource, consoleLocale());
  const metaParts = [
    item.proposer ? renderProposer(item.proposer) : "",
    time ? escapeHtml(time) : "",
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
          ${item.baseConflict ? `<span class="queue-row-stale" title="${escapeAttribute(patchBaseConflictMessage(item.baseConflict))}">${escapeHtml(t("codex.reading.staleBadge"))}</span>` : ""}
        </span>
        ${summary ? `<span class="queue-row-summary">${escapeHtml(summary)}</span>` : ""}
        ${metaParts.length > 0 ? `<span class="queue-row-meta">${metaParts.join(" \u00b7 ")}</span>` : ""}
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
  const targetLabel = op === "delete_wiki" ? t("codex.reading.opDelete") : targetExists ? t("codex.reading.replaceExisting") : t("codex.reading.createNew");
  const isPending = meta.status === "pending";
  const versionLabel = detail.baseConflict
    ? stalePatchVersionLabel(detail.baseConflict)
    : options.currentVersion !== null
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

  const deletionSummary = detail.deletion ? `<section class="queue-deletion-impact" role="note">
    <h2>${escapeHtml(t("codex.reading.proposeDelete"))}</h2>
    ${detail.deletion.targetMissing ? `<p>${escapeHtml(t("codex.reading.deleteMissing"))}</p>` : ""}
    <p>${escapeHtml(t("codex.reading.deleteImpact", { links: detail.deletion.backlinks.length, raw: detail.deletion.rawSources.length }))}</p>
    ${detail.source === "archive" ? (meta.warnings ?? []).map(warning => `<p>${escapeHtml(warning)}</p>`).join("") : ""}
    ${detail.deletion.backlinks.map(link => `<p>[[wiki:${escapeHtml(wikiEntry.id)}]] ← ${escapeHtml(link.title)} (${escapeHtml(link.id)})${link.alsoDeleting ? ` · ${escapeHtml(t("codex.reading.deleteAlso"))}` : ""}</p>`).join("")}
    ${detail.deletion.rawSources.map(ref => `<p>${escapeHtml(t("codex.reading.deleteRawRemove"))}: ${escapeHtml(ref)}</p>`).join("")}
    ${detail.deletion.sharedRawSources.map(ref => `<p>${escapeHtml(t("codex.reading.deleteRawRetain"))}: ${escapeHtml(ref)}</p>`).join("")}
  </section>` : "";

  // 결정 독은 문서 위 스티키 — 근거(diff)와 결정 수단이 같은 화면에 머문다.
  return `
    <article class="document document--utility">
      <div class="queue-decision-dock">
        <div class="queue-decision-dock-copy">
          <span class="queue-decision-dock-title"><span class="op-badge" aria-label="${escapeAttribute(label)}">${glyph}</span> ${escapeHtml(wikiEntry.title)}</span>
          <span class="queue-decision-dock-meta">${escapeHtml(patch.frontmatter.target)} \u00b7 <span data-patch-version>${escapeHtml(versionLabel)}</span> \u00b7 ${escapeHtml(targetLabel)}${patch.frontmatter.proposer ? ` \u00b7 ${renderProposer(patch.frontmatter.proposer)}` : ""} ${diffstatHtml}</span>
        </div>
        <div class="queue-decision-dock-actions" data-decision-bar-wrap>
          ${isPending ? renderDecisionBarContent("idle", null, detail.baseConflict ? patchBaseConflictMessage(detail.baseConflict) : null) : renderDecidedState(meta)}
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
      ${deletionSummary}
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
      resolveLink: resolveCodexFileLink,
      ...markdownCopyOptions(t),
    }).html;
    if (block.kind === "same") return html;
    const label = block.kind === "added" ? t("codex.reading.diffAdded") : t("codex.reading.diffRemoved");
    const symbol = block.kind === "added" ? "+" : "−";
    return `<div class="cowork-block cowork-block--${block.kind}"><span class="queue-diff-block-label">${symbol} ${escapeHtml(label)}</span>${html}</div>`;
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

/**
 * 제안자 각인 — 패치 frontmatter의 proposer는 "tool:wiki_compile_source"나 "wiki_query" 같은
 * 기계 식별자다. 접두를 걷어 도구 이름만 남기고, 도구 표식과 함께 읽기 전용으로 그린다.
 * 컨트롤처럼 보이면 거짓 약속이므로 버튼이 아니다.
 */
function renderProposer(proposer: string): string {
  const t = consoleT();
  const trimmed = proposer.trim();
  const tool = trimmed.replace(/^tool:/u, "");
  const isTool = trimmed.startsWith("tool:") || /^wiki_[a-z_]+$/u.test(trimmed);
  const label = isTool ? tool : trimmed;
  return `<span class="queue-proposer" title="${escapeAttribute(t("codex.reading.proposedBy", { name: label }))}">`
    + `<span class="queue-proposer-mark" aria-hidden="true">${isTool ? "⚙" : "◎"}</span>${escapeHtml(label)}</span>`;
}

function renderPatchMetaChips(proposer: string, tags: string[]): string {
  const parts: string[] = [];
  if (proposer) parts.push(`<span class="meta-chip meta-chip--proposer">${renderProposer(proposer)}</span>`);
  if (tags.length > 0) parts.push(renderTagChips(tags));
  if (parts.length === 0) return "";
  return `<div class="meta-chips">${parts.join("")}</div>`;
}

function stalePatchVersionLabel(conflict: DrydockBaseConflict): string {
  const t = consoleT();
  if (conflict.currentVersion === null) return t("codex.reading.staleVersionMissing");
  if (conflict.baseVersion !== undefined) {
    return t("codex.reading.staleVersionLabel", { base: conflict.baseVersion, current: conflict.currentVersion });
  }
  return t("codex.reading.staleVersionChanged", { current: conflict.currentVersion });
}

function patchBaseConflictMessage(conflict?: DrydockBaseConflict): string {
  const t = consoleT();
  if (conflict?.reason === "base_version" && conflict.baseVersion !== undefined && conflict.currentVersion !== null) {
    return t("codex.reading.staleBaseVersion", { base: conflict.baseVersion, current: conflict.currentVersion });
  }
  return t("codex.reading.staleBase");
}

function renderDecisionBarContent(
  phase: "idle" | "approving" | "rejecting" | "submitting",
  error: string | null,
  approvalBlocked: string | null,
): string {
  const t = consoleT();
  const warning = approvalBlocked ? `<p class="queue-action-error" role="alert">${escapeHtml(approvalBlocked)}</p>` : "";
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
      ${warning}
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
    ${warning}
    <div class="queue-action-buttons">
      <button type="button" class="queue-action-btn queue-action-btn--approve" data-drydock-action="approve"${approvalBlocked ? " disabled" : ""}>${escapeHtml(t("codex.reading.approve"))}</button>
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

function pendingPatchLabel(count: number): string {
  return count > 0 ? `<span class="entry-pending-patches">${escapeHtml(consoleT()("codex.reading.pendingPatches", { count }))}</span>` : "";
}

function conflictStatusLabel(status: string | undefined, t: T): string {
  if (status === "resolved") return t("codex.reading.conflictResolved");
  if (status === "unresolved") return t("codex.reading.conflictOpen");
  if (!status || status === "open") return t("codex.reading.conflictOpen");
  return t("codex.reading.conflictUnknown");
}

function renderConflictDetail(detail: ConflictDetailResponse): string {
  const t = consoleT();
  const status = conflictStatusLabel(detail.status ?? detail.meta?.status as string | undefined, t);
  return `
    <article class="document document--conflict">
      <header class="document-header">
        <nav class="breadcrumb" aria-label="${escapeAttribute(t("codex.reading.entryLocationAria"))}">
          <ol><li><span>Codex</span></li><li><span>${escapeHtml(t("codex.reading.conflicts"))}</span></li></ol>
        </nav>
        <button type="button" class="queue-back-btn" data-conflict-action="back" aria-label="${escapeAttribute(t("codex.reading.backConflicts"))}">${escapeHtml(t("codex.reading.backConflicts"))}</button>
        <h1>${escapeHtml(detail.title ?? t("codex.reading.conflicts"))}</h1>
        <p class="eyebrow">${escapeHtml(t("codex.reading.conflictEyebrow", { status }))}</p>
      </header>
      <section data-conflict-controls></section>
      ${renderConflictComparison(detail, t)}
    </article>
  `;
}

function renderConflictControls(detail: ConflictDetailResponse, action: "reject" | "repropose" | "resolve" | null, busy: boolean, error: string | null, note: string): string {
  const t = consoleT();
  if (detail.status === "resolved" || detail.meta.status === "resolved") return `<p class="conflict-resolved">${escapeHtml(t("codex.reading.conflictResolved"))}${typeof detail.meta.note === "string" ? ` · ${escapeHtml(detail.meta.note)}` : ""}</p>`;
  if (detail.status === "unknown") return `<p>${escapeHtml(t("codex.reading.conflictUnknown"))}</p>`;
  const warning = !detail.base ? `<p class="conflict-base-warning">${escapeHtml(t("codex.reading.conflictBaseMissing"))}</p>` : "";
  const errorHtml = error ? `<p class="queue-action-error" role="alert">${escapeHtml(error)}</p>` : "";
  if (!action) return `${warning}<div class="queue-action-buttons"><button type="button" class="queue-action-btn queue-action-btn--reject" data-conflict-action="reject">${escapeHtml(t("codex.reading.conflictReject"))}</button><button type="button" class="queue-action-btn queue-action-btn--approve" data-conflict-action="repropose"${detail.canRepropose ? "" : " disabled"}>${escapeHtml(t("codex.reading.conflictRepropose"))}</button><button type="button" class="queue-action-btn" data-conflict-action="resolve">${escapeHtml(t("codex.reading.conflictResolve"))}</button></div>${errorHtml}`;
  const impact = action === "repropose" ? t("codex.reading.conflictReproposalImpact") : detail.pendingPatch ? t("codex.reading.conflictResolutionImpact") : t("codex.reading.conflictNoWrite");
  return `${warning}<p class="queue-decision-confirm">${escapeHtml(impact)}</p><textarea data-conflict-note maxlength="256" rows="3" aria-label="${escapeAttribute(t("codex.reading.conflictNote"))}" placeholder="${escapeAttribute(t("codex.reading.conflictNote"))}">${escapeHtml(note)}</textarea><div class="queue-action-buttons"><button type="button" class="queue-action-btn${action === "reject" ? " queue-action-btn--reject" : ""}" data-conflict-action="confirm"${busy ? " disabled" : ""}>${escapeHtml(t("codex.reading.conflictConfirm"))}</button><button type="button" class="queue-action-btn" data-conflict-action="cancel"${busy ? " disabled" : ""}>${escapeHtml(t("common.cancel"))}</button></div>${errorHtml}`;
}

function renderConflictComparison(detail: ConflictDetailResponse, t: T): string {
  const body = (markdown: string) => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/u, "");
  const panel = (label: string, markdown: string | null | undefined, key?: string) => `<section class="conflict-compare-panel"${key ? ` id="conflict-panel-${key}" data-conflict-panel="${key}" role="tabpanel" aria-labelledby="conflict-tab-${key}"` : ""}><h2>${escapeHtml(label)}</h2><div class="markdown-body">${markdown ? renderMarkdown(body(markdown), { ...markdownCopyOptions(t), resolveWikiLink: entryPath, resolveLink: resolveCodexFileLink }).html + `<details><summary>${escapeHtml(t("codex.reading.conflictSource"))}</summary><pre><code>${escapeHtml(markdown)}</code></pre></details>` : `<p>${escapeHtml(t("codex.reading.conflictSnapshotMissing"))}</p>`}</div></section>`;
  const labels = [["base", t("codex.reading.conflictBase")], ["current", t("codex.reading.current")], ["proposed", t("codex.reading.proposed")]] as const;
  const tabs = `<div class="conflict-panel-tabs" role="tablist" aria-label="${escapeAttribute(t("codex.reading.conflictCompareAria"))}">${labels.map(([key, label]) => `<button id="conflict-tab-${key}" type="button" role="tab" data-conflict-panel-tab="${key}" aria-controls="conflict-panel-${key}" aria-selected="${String(key === "base")}" tabindex="${key === "base" ? "0" : "-1"}">${escapeHtml(label)}</button>`).join("")}</div>`;
  const panels = `${tabs}<div class="conflict-comparison" data-active-panel="base">${panel(t("codex.reading.conflictBase"), detail.base, "base")}${panel(t("codex.reading.current"), detail.current, "current")}${panel(t("codex.reading.proposed"), detail.proposed, "proposed")}</div>`;
  const diff = detail.current && detail.proposed ? `<details class="conflict-diff"><summary>${escapeHtml(t("codex.cowork.viewDiff"))}</summary>${renderDiffBlocks(diffDraftBlocks(body(detail.current), body(detail.proposed)), "full")}</details>` : "";
  const historical = !detail.current && detail.currentAtConflict ? `<details><summary>${escapeHtml(t("codex.reading.conflictCaptured"))}</summary>${panel(t("codex.reading.conflictCaptured"), detail.currentAtConflict)}</details>` : "";
  return panels + diff + historical;
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

function conflictCreatedLabel(item: ConflictListItem): string {
  const time = Date.parse(item.createdAt ?? "");
  if (!Number.isFinite(time)) return "";
  const at = new Date(time).toLocaleString(consoleLocale(), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 });
  return consoleT()("codex.reading.conflictCreatedAt", { at });
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
                  <button class="queue-row conflict-row" type="button" data-conflict-id="${escapeAttribute(item.id)}" aria-label="${escapeAttribute([t("codex.reading.openConflict", { title: item.title || item.id }), conflictCreatedLabel(item)].filter(Boolean).join(" · "))}">
                    <span class="queue-row-body">
                      <strong class="queue-row-target">${escapeHtml(item.title || item.id)}</strong>
                      <span class="eyebrow">${escapeHtml(conflictStatusLabel(item.status, t))}</span>
                      ${item.createdAt ? `<span class="queue-row-meta">${escapeHtml(conflictCreatedLabel(item))}</span>` : ""}
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
