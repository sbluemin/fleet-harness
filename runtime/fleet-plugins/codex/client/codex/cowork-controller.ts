import { renderMarkdown } from "@fleet-console/markdown/core";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { getT, markdownCopyOptions } from "../i18n/index.js";
import { resolveActiveLocale } from "../i18n/index.js";
import {
  applyCowork, cancelCowork, closeCowork, CoworkRequestError, createCoworkSession,
  fetchCoworkOptions, peekCoworkEntrySession, promptCowork, subscribeCoworkEvents,
  updateCoworkAnnotations, updateCoworkSelection, updateCoworkSettings,
} from "./api.js";
import type { CoworkAnnotationDto, CoworkModelRow, CoworkOptionsResponse, CoworkSessionDto } from "./api.js";
import { diffDraftBlocks, diffDraftLines } from "@fleet-console/markdown/diff";
import type { DraftLine } from "@fleet-console/markdown/diff";
import { CoworkThread } from "./cowork-thread.js";
import type { CoworkNotice, CoworkStep, CoworkThreadActions, CoworkThreadState, CoworkTurn } from "./cowork-thread.js";
import { entryPath } from "./router.js";
import { escapeAttribute, escapeHtml } from "./utils.js";


function consoleT() {
  return getT(resolveActiveLocale());
}

export interface CoworkController { destroy(): void; }

export interface MountCoworkInlineOptions {
  theaterId: string | null;
  entryId: string;
  /** 렌더 중복 제거용 엔트리 제목 */
  title: string;
  /** 리딩 뷰를 감싸는 article — 선택 필/코멘트 컴포저의 포지셔닝 호스트 */
  article: HTMLElement;
  /** 엔트리 마크다운이 렌더된 본문 요소 — 초안 렌더 시 이 내용만 교체 */
  body: HTMLElement;
  /**
   * 도크(스레드·컴포저)가 정박할 프레임 경계 요소. 본문 스크롤 흐름 밖에 두어야
   * 읽는 중인 문단을 가리지 않는다. 생략 시 article 말미(레거시 흐름 내 위치).
   */
  dockHost?: HTMLElement;
  onApplied(): void;
}

interface Settings { model: string; effort: string; }
interface AnnotationCard { id: string; quote: string; comment: string; status: "pending" | "sent" | "done"; }
interface PromptAttempt { cancelled: boolean; submitted: boolean; }

const SETTINGS_KEY = "fleet.codex.cowork.settings";
const STREAM_RENDER_DELAY_MS = 32;
/** 도는 턴의 경과 티커 — 스레드의 "N초" 표시가 이 주기로 갱신된다. */
const TICK_MS = 1000;
/** 서버가 던지는 오류 코드 → 사용자에게 보이는 원인별 문구. */
/**
 * 적용 직후 리딩 뷰가 다시 그려지며 컨트롤러가 재마운트된다 — 그 경계를 넘겨 보여 줄 "적용됨"
 * 안내를 엔트리별로 잠시 맡긴다. 다음 마운트가 한 번 꺼내 쓰고 지운다.
 */
const pendingNotices = new Map<string, CoworkNotice>();
/**
 * 서버가 던지는 오류 코드 → 사용자에게 보이는 원인별 문구. 서비스는 연결 준비 실패를
 * `provider_unavailable`(HTTP는 `cowork_provider_unavailable`)로, 그 밖의 provider 실패는 커넥터의
 * `cowork_*` 코드 또는 `provider_error`로 낸다.
 */
const NOTICE_BY_CODE: Readonly<Record<string, CoworkNotice["kind"]>> = {
  provider_unavailable: "gateway",
  cowork_provider_unavailable: "gateway",
  cowork_gateway_unavailable: "gateway",
  provider_error: "turn",
  cowork_turn_timeout: "timeout",
  cowork_turn_incomplete: "turn",
  cowork_turn_failed: "turn",
  cowork_model_not_enabled: "noModel",
  cowork_apply_stale: "stale",
  cowork_apply_stale_revision: "stale",
  cowork_apply_busy: "stale",
};

/**
 * 리딩 뷰 인라인 Cowork 증강 — 별도 화면 전환 없이 엔트리 문서 위에서 동작한다.
 * 드래그 선택 → 플로팅 Comment 필 → 코멘트 컴포저 → 하단 스레드(턴 원장·리뷰·컴포저)로 이어지며,
 * 세션은 첫 코멘트 시점에 지연 생성되고 기존 활성 세션은 peek으로 자동 복원된다.
 *
 * 본문(초안/diff)과 선택 필은 이 컨트롤러가 직접 그리고, 도크는 React 섬(CoworkThread)이
 * 스냅샷을 받아 그린다. 스레드 이력은 이 마운트 동안만 산다 — 적용된 결과는 Drydock
 * 아카이브가, 진행 중 초안은 서버 세션이 각각 보존한다.
 */
export function mountCoworkInline(options: MountCoworkInlineOptions): CoworkController {
  let disposed = false;
  let session: CoworkSessionDto | null = null;
  let unsubscribe: (() => void) | null = null;
  let lastEventId = 0;
  let optionsDto: CoworkOptionsResponse = { models: [], efforts: [] };
  let settings = readSettings();
  let annotations: AnnotationCard[] = [];
  let turns: CoworkTurn[] = [];
  let reply = "";
  let renderedReplyText = "";
  let renderedReplyHtml = "";
  let revisionRenderTimer: number | null = null;
  let selection: { quote: string; top: number; left: number } | null = null;
  let composerOpen = false;
  let panelOpen = false;
  let confirmAction: "apply" | "discard" | null = null;
  let diffVisible = false;
  // 이번 마운트에서 직접 보낸 실행의 완료만 diff 자동 전환 대상(리플레이 done 제외).
  let awaitingResult = false;
  // 서버의 running DTO가 돌아오기 전에도 전송을 잠가 동일 프롬프트의 재진입을 막는다.
  let promptPending = false;
  let promptAttempt: PromptAttempt | null = null;
  let promptText = "";
  let notice: CoworkNotice | null = pendingNotices.get(options.entryId) ?? null;
  pendingNotices.delete(options.entryId);
  let lastBodyKey = "published";
  let diffMemo: { base: string; draft: string; lines: readonly DraftLine[] } | null = null;
  let threadRoot: Root | null = null;
  let tickTimer: number | null = null;
  let lastInstruction: { text: string; quote: string | null } | null = null;

  // SSE 이벤트마다 LCS를 다시 돌리지 않도록 draft 쌍 기준으로 메모한다.
  const draftLines = (): readonly DraftLine[] => {
    if (!session) return [];
    if (!diffMemo || diffMemo.base !== session.baseDraft || diffMemo.draft !== session.draft) {
      diffMemo = { base: session.baseDraft, draft: session.draft, lines: diffDraftLines(session.baseDraft, session.draft) };
    }
    return diffMemo.lines;
  };

  const publishedHtml = options.body.innerHTML;
  const anchor = document.createElement("div");
  anchor.className = "cowork-anchor";
  const dockZone = document.createElement("div");
  dockZone.className = "cowork-dock-zone";
  const tip = document.createElement("div");
  tip.className = "cowork-tip";
  tip.hidden = true;
  options.article.classList.add("cowork-host");
  options.article.append(anchor, tip);
  // 도크는 스크롤포트 밖 프레임 경계에 선다 — 본문 위 부유(가림)를 만들지 않는다.
  (options.dockHost ?? options.article).append(dockZone);

  // ── 턴 원장 ─────────────────────────────────────────────────────────────────

  const currentTurn = (): CoworkTurn | null => {
    const last = turns[turns.length - 1];
    return last && (last.state === "running" || last.state === "pending") ? last : null;
  };
  const patchTurn = (id: string, patch: Partial<CoworkTurn>) => {
    turns = turns.map((turn) => turn.id === id ? { ...turn, ...patch } : turn);
  };
  // 서버가 idle로 돌아온 뒤 결과 이벤트를 기다리는 짧은 정산 구간도 "도는 중"이다 — 그 사이
  // 컴포저를 열면 done이 닫을 턴 위에 새 턴이 겹친다.
  const isRunning = () => promptPending || (!!session && (session.state === "running" || settleTimer !== null) && currentTurn() !== null);

  // ── 렌더 ────────────────────────────────────────────────────────────────────

  const renderBody = () => {
    if (disposed) return;
    const t = consoleT();
    const engaged = !!session && session.state !== "closed";
    const key = !engaged ? "published" : diffVisible ? `diff:${session!.draft}` : `draft:${session!.draft}`;
    if (key === lastBodyKey) return;
    lastBodyKey = key;
    if (!engaged) { options.body.innerHTML = publishedHtml; return; }
    options.body.innerHTML = diffVisible
      ? `<div class="cowork-rendered-diff" aria-label="${escapeAttribute(t("codex.cowork.draftChangesAria"))}">${renderRenderedDiff(stripFrontmatter(session!.baseDraft), stripFrontmatter(session!.draft))}</div>`
      : renderMarkdown(stripFrontmatter(session!.draft), { omitDuplicateTitle: options.title, resolveWikiLink: (id) => entryPath(id), ...markdownCopyOptions(t) }).html;
  };

  const renderAnchor = () => {
    if (disposed) return;
    if (!selection) { anchor.innerHTML = ""; return; }
    const t = consoleT();
    // 중앙 정렬(translateX(-50%)) 기준이므로 요소 절반 폭만큼 안쪽으로 클램프해야
    // 문서 좌우 경계에서 잘리지 않는다. 컴포저 폭은 CSS min(340px, 86%)와 동기.
    const hostWidth = options.article.getBoundingClientRect().width || 0;
    const half = composerOpen ? Math.min(340, hostWidth * 0.86) / 2 + 8 : 56;
    const left = Math.min(Math.max(selection.left, half), Math.max(hostWidth - half, half));
    const at = `style="top:${selection.top}px;left:${left}px"`;
    anchor.innerHTML = composerOpen
      ? `<div class="cowork-composer" ${at} role="dialog" aria-label="${escapeAttribute(t("codex.cowork.addCommentAria"))}">
          <blockquote>${escapeHtml(clip(selection.quote, 140))}</blockquote>
          <textarea class="cowork-composer-input" rows="2" placeholder="${escapeAttribute(t("codex.cowork.commentPlaceholder"))}" aria-label="${escapeAttribute(t("codex.cowork.commentAria"))}"></textarea>
          <div class="cowork-composer-actions">
            <button type="button" class="cowork-ghost" data-cowork-action="cancel-comment">${escapeHtml(t("common.cancel"))}</button>
            <button type="button" class="cowork-solid" data-cowork-action="add-comment">${escapeHtml(t("codex.cowork.add"))}</button>
          </div>
        </div>`
      : `<button type="button" class="cowork-pill" data-cowork-action="comment" ${at}><span aria-hidden="true">✦</span>${escapeHtml(t("codex.cowork.comment"))}</button>`;
    if (composerOpen) anchor.querySelector<HTMLTextAreaElement>(".cowork-composer-input")?.focus();
  };

  const threadState = (): CoworkThreadState => {
    const engaged = !!session && session.state !== "closed" && session.state !== "applied";
    const running = isRunning();
    const dirty = engaged && !running && session!.baseDraft !== session!.draft;
    const changed = dirty ? draftLines().filter(line => line.changed).length : 0;
    return {
      locale: resolveActiveLocale() === "ko" ? "ko" : "en",
      turns,
      running,
      models: optionsDto.rows ?? optionsDto.models.map((id): CoworkModelRow => ({ id, label: id, provider: "claude" })),
      efforts: optionsDto.efforts,
      model: settings.model,
      effort: settings.effort,
      annotations,
      panelOpen,
      promptText,
      dirty,
      changed,
      draftVersion: session ? session.baseVersion + 1 : 0,
      diffVisible,
      confirmAction,
      notice,
      now: Date.now(),
    };
  };

  const actions: CoworkThreadActions = {
    onPromptChange: (value) => { promptText = value; renderDock(); },
    onSend: () => { void send(); },
    onStop: () => stop(),
    onSelectModel: (model) => handleSelect(model, settings.effort),
    onSelectEffort: (effort) => handleSelect(settings.model, effort),
    onTogglePanel: () => { panelOpen = !panelOpen; renderDock(); },
    onDeleteAnnotation: (id) => { void deleteAnnotation(id); },
    onCommentChange: (id, comment) => {
      annotations = annotations.map(card => card.id === id ? { ...card, comment, status: "pending" } : card);
      renderDock();
    },
    onCommentCommit: () => { void persistAnnotations().catch(() => undefined); },
    onDiffMode: (mode) => { diffVisible = mode === "changes"; redraw(); },
    onApplyArm: () => { confirmAction = "apply"; renderDock(); },
    onDiscardArm: () => { confirmAction = "discard"; renderDock(); },
    onConfirmBack: () => { confirmAction = null; renderDock(); },
    onApplyConfirm: () => { void apply(); },
    onDiscardConfirm: () => { void discard(); },
    onSuggest: (text) => {
      promptText = text;
      renderDock();
      dockZone.querySelector<HTMLTextAreaElement>(".cowork-composer-input")?.focus();
    },
    onRetry: () => {
      if (!lastInstruction) return;
      promptText = lastInstruction.text;
      notice = null;
      void send();
    },
    onDismissNotice: () => { notice = null; renderDock(); },
  };

  const renderDock = () => {
    if (disposed) return;
    // 도크는 세션 유무와 무관하게 엔트리를 열면 항상 떠 있다. 세션은 첫 전송/코멘트 시점에 지연 생성된다.
    dockZone.classList.add("is-open");
    const running = isRunning();
    options.body.classList.toggle("is-cowork-running", running);
    if (!threadRoot) threadRoot = createRoot(dockZone);
    threadRoot.render(createElement(CoworkThread, { state: threadState(), actions }));
    syncTick(running);
  };

  // 도는 동안만 매초 다시 그린다 — 경과 시간 외에 바뀌는 것이 없으니 렌더는 싸다.
  const syncTick = (running: boolean) => {
    if (running && tickTimer === null) {
      tickTimer = window.setInterval(() => { if (!disposed && isRunning()) renderDock(); else syncTick(false); }, TICK_MS);
    } else if (!running && tickTimer !== null) {
      window.clearInterval(tickTimer);
      tickTimer = null;
    }
  };

  const cancelRevisionRender = () => {
    if (revisionRenderTimer !== null) window.clearTimeout(revisionRenderTimer);
    revisionRenderTimer = null;
  };

  const renderReplyMarkdown = () => {
    if (renderedReplyText === reply) return;
    renderedReplyText = reply;
    renderedReplyHtml = reply ? renderMarkdown(reply, markdownCopyOptions(consoleT())).html : "";
    const turn = currentTurn();
    if (turn) patchTurn(turn.id, { replyHtml: renderedReplyHtml, hasReply: reply.length > 0 });
  };

  const scheduleRevisionOutput = () => {
    if (revisionRenderTimer !== null) return;
    revisionRenderTimer = window.setTimeout(() => {
      revisionRenderTimer = null;
      if (disposed) return;
      renderReplyMarkdown();
      renderDock();
    }, STREAM_RENDER_DELAY_MS);
  };

  const flushRevisionOutput = () => {
    cancelRevisionRender();
    renderReplyMarkdown();
  };

  // 결과 이벤트 없이 idle로 돌아간 턴의 정산 유예 — done/error가 오면 취소된다.
  const SETTLE_GRACE_MS = 2_000;
  let settleTimer: number | null = null;
  const clearSettle = () => { if (settleTimer !== null) window.clearTimeout(settleTimer); settleTimer = null; };
  const scheduleSettle = (turnId: string) => {
    clearSettle();
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      if (disposed) return;
      const turn = turns.find(candidate => candidate.id === turnId);
      if (!turn || (turn.state !== "running" && turn.state !== "pending")) return;
      flushRevisionOutput();
      awaitingResult = false;
      patchTurn(turnId, { state: "stopped", endedAt: Date.now(), steps: turn.steps.map(step => step.status === "running" ? { ...step, status: "done" } : step) });
      annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "pending" } : card);
      redraw();
    }, SETTLE_GRACE_MS);
  };

  // 어노테이션 인용문을 렌더된 본문에 하이라이트(mark)로 표시한다. 인용문이 여러 텍스트
  // 노드에 걸치면 노드별 조각으로 나눠 감싸고, 편집으로 사라진 인용문은 조용히 생략한다.
  const applyMarks = () => {
    if (disposed) return;
    for (const mark of [...options.body.querySelectorAll("mark.cowork-mark")]) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    }
    options.body.normalize();
    if (diffVisible) return;
    for (const card of annotations) {
      if (card.quote) markQuote(card);
    }
  };

  const markQuote = (card: AnnotationCard) => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(options.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    let full = "";
    const starts: number[] = [];
    for (const node of nodes) { starts.push(full.length); full += node.data; }
    const at = full.indexOf(card.quote);
    if (at < 0) return;
    const end = at + card.quote.length;
    for (let index = 0; index < nodes.length; index += 1) {
      const nodeStart = starts[index]!;
      const nodeEnd = nodeStart + nodes[index]!.data.length;
      const from = Math.max(at, nodeStart);
      const to = Math.min(end, nodeEnd);
      if (from >= to) continue;
      const range = document.createRange();
      range.setStart(nodes[index]!, from - nodeStart);
      range.setEnd(nodes[index]!, to - nodeStart);
      const mark = document.createElement("mark");
      mark.className = "cowork-mark";
      mark.dataset.annotationId = card.id;
      try { range.surroundContents(mark); } catch { /* 요소 경계와 겹치는 조각은 생략한다. */ }
    }
  };

  const showTip = (mark: HTMLElement) => {
    const card = annotations.find(a => a.id === mark.dataset.annotationId);
    if (!card) { tip.hidden = true; return; }
    tip.textContent = card.comment.trim() || consoleT()("codex.cowork.noCommentYet");
    tip.hidden = false;
    const rect = mark.getBoundingClientRect();
    const host = options.article.getBoundingClientRect();
    // 중앙 정렬(translateX(-50%))이므로 실측 절반 폭만큼 안쪽으로 클램프해야 경계에서 잘리지 않는다.
    const half = tip.offsetWidth / 2 + 8;
    tip.style.top = `${Math.max(rect.top - host.top - 6, 0)}px`;
    tip.style.left = `${Math.min(Math.max(rect.left + rect.width / 2 - host.left, half), Math.max(host.width - half, half))}px`;
  };

  const redraw = () => { renderBody(); renderDock(); applyMarks(); };

  // ── 설정 ────────────────────────────────────────────────────────────────────

  // 세션 설정 동기화는 한 번에 하나만 비행한다 — 트랙 드래그는 단을 지날 때마다 변경을 내므로,
  // 병렬 POST의 완료 순서가 뒤집히면 중간 강도가 세션의 최종값으로 남는다. 비행 중 변경은 표시만
  // 해 두고, 착지 후 그 시점의 최신 settings로 한 번만 더 보낸다(중간 값은 싣지 않는다).
  // 드레인 전체가 하나의 프라미스로 남는 것은 send()를 위해서다 — 큐가 비기 전에 프롬프트가
  // 출발하면, 도크가 보여 주는 값이 아니라 중간 값으로 턴이 돈다.
  let settingsSyncInFlight = false;
  let settingsSyncQueued = false;
  let settingsSyncDrain: Promise<void> = Promise.resolve();
  const syncSessionSettings = () => {
    if (!session || disposed) return;
    if (settingsSyncInFlight) {
      settingsSyncQueued = true;
      return;
    }
    settingsSyncInFlight = true;
    settingsSyncDrain = (async () => {
      do {
        settingsSyncQueued = false;
        try {
          const next = await updateCoworkSettings(options.theaterId, session!.id, settings);
          if (!disposed) session = next;
        } catch (cause) {
          notice = noticeFrom(cause);
          renderDock();
        }
      } while (settingsSyncQueued && !disposed);
      settingsSyncInFlight = false;
    })();
  };

  const handleSelect = (model: string, effort: string) => {
    const modelChanged = model !== settings.model;
    settings = { model, effort };
    saveSettings(settings);
    renderDock();
    if (modelChanged) {
      // 모델이 바뀌면 강도 사다리가 달라질 수 있다 — 재조회가 강도를 정규화한 뒤 도크를 다시 세운다.
      void updateOptions()
        .then(() => { syncSessionSettings(); renderDock(); })
        .catch((cause) => { notice = noticeFrom(cause); renderDock(); });
      return;
    }
    syncSessionSettings();
  };

  const updateOptions = async () => {
    optionsDto = await fetchCoworkOptions(options.theaterId, settings.model || undefined);
    // 저장값이 무효하면 제품 기본값(sonnet/low)을 우선 채택한다.
    const fallbackModel = optionsDto.defaultModel && optionsDto.models.includes(optionsDto.defaultModel) ? optionsDto.defaultModel : optionsDto.models[0] ?? "";
    const fallbackEffort = optionsDto.defaultEffort && optionsDto.efforts.includes(optionsDto.defaultEffort) ? optionsDto.defaultEffort : optionsDto.efforts[0] ?? "";
    settings = {
      model: optionsDto.models.includes(settings.model) ? settings.model : fallbackModel,
      effort: optionsDto.efforts.includes(settings.effort) ? settings.effort : fallbackEffort,
    };
    saveSettings(settings);
    if (optionsDto.models.length === 0) notice = { kind: "noModel", message: consoleT()("codex.cowork.noModel") };
    else if (notice?.kind === "noModel") notice = null;
  };

  // ── 세션 수명주기 ───────────────────────────────────────────────────────────

  const engage = async (next: CoworkSessionDto) => {
    session = next;
    // 지연 생성 경로에서는 서버에 아직 저장되지 않은 로컬 카드(첫 코멘트)를 보존해야 한다.
    const restored: AnnotationCard[] = next.annotations.map(annotationFromDto);
    const known = new Set(restored.map(card => card.id));
    annotations = [...restored, ...annotations.filter(card => !known.has(card.id))];
    if (next.cli || next.model || next.effort) {
      settings = { model: next.model ?? settings.model, effort: next.effort ?? settings.effort };
      saveSettings(settings);
    }
    try { await updateOptions(); } catch { /* 모델 메뉴가 비어 보일 뿐, 편집은 계속 가능하다. */ }
    if (disposed) return;
    // 세션에 저장된 모델이 레지스트리에서 사라져 정규화로 바뀌었으면, 첫 실행이
    // 무효 모델로 접속하지 않도록 서버 세션 설정을 즉시 동기화한다.
    if (session && (session.model !== settings.model || session.effort !== settings.effort)) {
      try { session = await updateCoworkSettings(options.theaterId, session.id, settings); } catch { /* 전송 시 오류로 표면화된다. */ }
    }
    if (disposed) return;
    // 복원된 세션이 이미 돌고 있으면 — 다른 탭이 보냈거나 새로고침 — 스트림을 받을 턴을 세운다.
    if (session?.state === "running" && !currentTurn()) {
      turns = [...turns, newTurn("", null, 0)];
    }
    subscribe();
    redraw();
  };

  const ensureSession = async (): Promise<CoworkSessionDto> => {
    if (session && session.state !== "closed" && session.state !== "applied") return session;
    const created = await createCoworkSession(options.theaterId, options.entryId, settings);
    await engage(created);
    return created;
  };

  // 도크는 즉시 표시하고, 옵션 목록(모델/effort)도 세션 없이 미리 채운다.
  renderDock();
  void updateOptions().then(renderDock).catch(() => { notice = { kind: "gateway", message: consoleT()("codex.cowork.gatewayUnavailable") }; renderDock(); });
  void (async () => {
    try {
      const existing = await peekCoworkEntrySession(options.theaterId, options.entryId);
      if (!disposed && existing) await engage(existing);
    } catch { /* peek 실패는 dormant 유지 — 선택 시 생성 경로가 살아있다. */ }
  })();

  function subscribe(): void {
    if (!session) return;
    unsubscribe?.();
    unsubscribe = subscribeCoworkEvents(options.theaterId, session.id, lastEventId, (event, id) => {
      if (id && id <= lastEventId) return;
      lastEventId = Math.max(lastEventId, id);
      const wasRunning = session?.state === "running";
      if (event.session) session = event.session;
      const turn = currentTurn();
      if (event.type === "transcript" && event.text && session?.state === "running") {
        if (!turn) return;
        reply = reply + event.text;
        scheduleRevisionOutput();
        return;
      }
      if (event.type === "tool" && event.text && turn) {
        patchTurn(turn.id, { steps: mergeStep(turn.steps, event.text) });
        renderDock();
        return;
      }
      if (event.type === "done") {
        flushRevisionOutput();
        // 제출 전에 취소된 지연 생성 요청은 뒤늦은 이벤트로 완료 처리하지 않는다.
        if (!promptAttempt?.cancelled || promptAttempt.submitted) {
          const completedObservedRun = wasRunning || awaitingResult || !!reply || !!turn;
          if (turn) {
            const dirty = !!session && session.baseDraft !== session.draft;
            const changed = dirty ? draftLines().filter(line => line.changed).length : 0;
            patchTurn(turn.id, {
              state: completedObservedRun ? "complete" : "stopped",
              endedAt: Date.now(),
              steps: turn.steps.map(step => step.status === "running" ? { ...step, status: "done" } : step),
              changed: dirty ? changed : null,
            });
          }
          annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "done" } : card);
          // AI 응답이 실제 변경(삭제-전용 포함)을 남겼으면 렌더드 diff로 전환해 검토를 유도한다.
          if (awaitingResult) {
            awaitingResult = false;
            if (session && session.baseDraft !== session.draft) diffVisible = true;
          }
        }
      }
      if (event.type === "done" || event.type === "error") clearSettle();
      if (event.type === "error") {
        flushRevisionOutput();
        awaitingResult = false;
        // 실패는 session(running→idle) 뒤에 error로 온다 — 정산 대기 중이던 마지막 턴을 실패로 적는다.
        const failing = turn ?? turns[turns.length - 1] ?? null;
        if (failing) {
          patchTurn(failing.id, {
            state: "error",
            endedAt: Date.now(),
            steps: failing.steps.map(step => step.status === "running" ? { ...step, status: "error" } : step),
            error: event.text ?? null,
          });
        }
        annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "pending" } : card);
        notice = noticeFromCode(event.text ?? "");
      }
      // running→idle 전이는 done/error 직전에도 오고, 다른 탭의 취소처럼 홀로 오기도 한다. 결과
      // 이벤트가 곧 따라오면 그쪽이 턴을 닫고, 오지 않으면 잠시 뒤 중지로 정산한다.
      if (event.type === "session" && wasRunning && session?.state !== "running" && turn) scheduleSettle(turn.id);
      redraw();
    });
  }

  // ── 어노테이션 & 전송 ───────────────────────────────────────────────────────

  async function addAnnotation(quote: string, comment: string): Promise<void> {
    annotations = [...annotations, { id: annotationId(), quote, comment, status: "pending" }];
    selection = null;
    composerOpen = false;
    renderAnchor();
    renderDock();
    applyMarks();
    try {
      await ensureSession();
      await mutate(() => updateCoworkSelection(options.theaterId, session!.id, quote));
      await persistAnnotations();
    } catch { /* mutate가 오류를 표면화한다. */ }
  }

  async function deleteAnnotation(id: string): Promise<void> {
    annotations = annotations.filter(card => card.id !== id);
    renderDock();
    applyMarks();
    tip.hidden = true;
    try { await persistAnnotations(); } catch { /* mutate가 오류를 표면화한다. */ }
  }

  async function persistAnnotations(): Promise<void> {
    if (!session) return;
    await mutate(() => updateCoworkAnnotations(options.theaterId, session!.id, annotations.map(annotationToDto)));
  }

  async function send(): Promise<void> {
    if (promptPending || session?.state === "running") return;
    // 이미 반영된(done) 카드는 재전송 대상에서 제외한다.
    const outgoing = annotations.filter(card => card.status !== "done");
    const localInstruction = promptText.trim();
    const t = consoleT();
    // 댓글만 보내는 턴은 사용자에게도 같은 문장으로 보인다 — 영문 고정 지시문을 화면 밖에 숨기지 않는다.
    const batchInstruction = outgoing.length === 1 ? t("codex.cowork.commentsBatchOne") : t("codex.cowork.commentsBatch", { count: outgoing.length });
    const prompt = localInstruction || (outgoing.length ? batchInstruction : "");
    if (!prompt) return;
    const attempt: PromptAttempt = { cancelled: false, submitted: false };
    promptAttempt = attempt;
    promptPending = true;
    annotations = outgoing.map(card => ({ ...card, status: "sent" }));
    cancelRevisionRender();
    reply = "";
    renderedReplyText = "";
    renderedReplyHtml = "";
    const quote = outgoing.length === 1 ? outgoing[0]!.quote : null;
    lastInstruction = { text: localInstruction, quote };
    turns = [...turns, newTurn(prompt, quote, outgoing.length)];
    notice = null;
    promptText = "";
    panelOpen = false;
    renderDock();
    applyMarks();
    try {
      // 도크 상시 표시: 세션이 아직 없으면 첫 전송 시점에 만든다.
      await ensureSession();
      if (attempt.cancelled || promptAttempt !== attempt) return;
      await mutate(() => updateCoworkAnnotations(options.theaterId, session!.id, annotations.map(annotationToDto)));
      if (attempt.cancelled || promptAttempt !== attempt) return;
      // 설정 쓰기 큐가 빌 때까지 기다린다 — 드래그 직후 곧장 보낸 프롬프트가 큐에 남은 최신
      // 강도보다 먼저 도착하면, 도크가 보여 주는 값이 아니라 중간 값으로 턴이 돈다.
      await settingsSyncDrain;
      if (attempt.cancelled || promptAttempt !== attempt) return;
      attempt.submitted = true;
      const turn = currentTurn();
      if (turn) patchTurn(turn.id, { state: "running" });
      await mutate(() => promptCowork(options.theaterId, session!.id, prompt));
      awaitingResult = true;
    } catch (cause) {
      if (!attempt.cancelled && promptAttempt === attempt) {
        awaitingResult = false;
        const turn = currentTurn();
        if (turn) patchTurn(turn.id, { state: "error", endedAt: Date.now(), error: cause instanceof Error ? cause.message : null });
        annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "pending" } : card);
      }
    } finally {
      if (!attempt.cancelled && promptAttempt === attempt) {
        promptPending = false;
        promptAttempt = null;
        renderDock();
      }
    }
  }

  function stop(): void {
    clearSettle();
    if (promptPending && promptAttempt && !promptAttempt.submitted) {
      promptAttempt.cancelled = true;
      promptPending = false;
      awaitingResult = false;
      const turn = currentTurn();
      if (turn) patchTurn(turn.id, { state: "stopped", endedAt: Date.now() });
      annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "pending" } : card);
      renderDock();
      applyMarks();
      return;
    }
    if (!session) return;
    void mutate(() => cancelCowork(options.theaterId, session!.id)).then(() => {
      flushRevisionOutput();
      const turn = currentTurn();
      if (turn) patchTurn(turn.id, { state: "stopped", endedAt: Date.now(), steps: turn.steps.map(step => step.status === "running" ? { ...step, status: "done" } : step) });
      annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "pending" } : card);
      renderDock();
    }).catch(() => undefined);
  }

  async function apply(): Promise<void> {
    if (!session) return;
    confirmAction = null;
    const from = session.baseVersion;
    const lastTurn = turns[turns.length - 1] ?? null;
    try {
      await mutate(() => applyCowork(options.theaterId, session!.id, session!.revision));
    } catch { return; }
    if (lastTurn) patchTurn(lastTurn.id, { applied: { from, to: from + 1 }, changed: null });
    notice = { kind: "applied", message: consoleT()("codex.cowork.applied") };
    diffVisible = false;
    renderDock();
    // onApplied는 엔트리를 다시 그려 이 컨트롤러를 내린다 — 안내는 다음 마운트에 넘긴다.
    pendingNotices.set(options.entryId, notice);
    options.onApplied();
  }

  // Discard는 초안만 버린다 — 도크(작업 흐름)는 유지해야 하므로 곧바로 새 세션을 연다.
  async function discard(): Promise<void> {
    if (!session) return;
    const closing = session.id;
    confirmAction = null;
    try {
      notice = null;
      await closeCowork(options.theaterId, closing);
    } catch (cause) {
      notice = noticeFrom(cause);
      renderDock();
      return;
    }
    unsubscribe?.();
    unsubscribe = null;
    lastEventId = 0;
    annotations = [];
    turns = [];
    cancelRevisionRender();
    reply = "";
    renderedReplyText = "";
    renderedReplyHtml = "";
    diffVisible = false;
    try {
      await engage(await createCoworkSession(options.theaterId, options.entryId, settings));
    } catch {
      session = null;
      redraw();
    }
  }

  async function mutate(run: () => Promise<CoworkSessionDto>): Promise<void> {
    try {
      notice = notice?.kind === "applied" ? null : notice;
      session = await run();
      redraw();
    } catch (cause) {
      notice = noticeFrom(cause);
      redraw();
      throw cause;
    }
  }

  function noticeFrom(cause: unknown): CoworkNotice {
    if (cause instanceof CoworkRequestError) return noticeFromCode(cause.code);
    if (cause instanceof Error && cause.message) return noticeFromCode(cause.message);
    return { kind: "generic", message: consoleT()("codex.cowork.requestFailed") };
  }

  function noticeFromCode(code: string): CoworkNotice {
    const t = consoleT();
    const kind = NOTICE_BY_CODE[code] ?? (code.startsWith("cowork_") ? "turn" : "generic");
    const message = kind === "gateway" ? t("codex.cowork.gatewayUnavailable")
      : kind === "timeout" ? t("codex.cowork.turnTimeout")
        : kind === "stale" ? t("codex.cowork.applyStale")
          : kind === "noModel" ? t("codex.cowork.modelNotEnabled")
            : t("codex.cowork.requestFailed");
    return { kind, message };
  }

  // ── 이벤트 ──────────────────────────────────────────────────────────────────

  const onMouseUp = (event: MouseEvent) => {
    if (composerOpen || isRunning()) return;
    // 필/컴포저 위에서의 mouseup은 앵커를 재구축하면 안 된다 — click 이벤트가
    // 도달하기 전에 대상 요소가 교체되어 버튼이 무반응이 된다.
    if (event.target instanceof Node && anchor.contains(event.target)) return;
    const range = window.getSelection();
    const quote = range?.toString().trim() ?? "";
    if (!quote || !range || range.rangeCount === 0 || !options.body.contains(range.anchorNode)) return;
    const rect = range.getRangeAt(0).getBoundingClientRect();
    const host = options.article.getBoundingClientRect();
    // 클램프는 렌더 시점(요소 폭 기준)에 하므로 여기서는 원시 중심 좌표만 저장한다.
    selection = {
      quote,
      top: rect.bottom - host.top + 8,
      left: Math.min(Math.max(rect.left + rect.width / 2 - host.left, 0), Math.max(host.width, 0)),
    };
    renderAnchor();
  };

  const onMouseDown = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    // 필 클릭 시 브라우저의 선택 해제를 막아 하이라이트를 유지한다.
    if (event.target.closest(".cowork-pill")) { event.preventDefault(); return; }
    if (!anchor.contains(event.target) && selection) { selection = null; composerOpen = false; renderAnchor(); }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (selection || composerOpen) { selection = null; composerOpen = false; renderAnchor(); }
      else if (panelOpen || confirmAction) { panelOpen = false; confirmAction = null; renderDock(); }
      return;
    }
    const target = event.target;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && target instanceof HTMLTextAreaElement && target.classList.contains("cowork-composer-input") && anchor.contains(target)) {
      event.preventDefault();
      submitComposer();
    }
  };

  const submitComposer = () => {
    const comment = anchor.querySelector<HTMLTextAreaElement>(".cowork-composer-input")?.value.trim() ?? "";
    if (!selection) return;
    void addAnnotation(selection.quote, comment);
  };

  const onClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const copyButton = event.target.closest<HTMLElement>('[data-action="copy-code"]');
    if (copyButton && dockZone.contains(copyButton)) {
      event.stopPropagation();
      const code = copyButton.closest("pre")?.getAttribute("data-code");
      if (code) copyCodeToClipboard(copyButton, code);
      return;
    }
    const target = event.target.closest<HTMLElement>("[data-cowork-action]");
    if (!target) return;
    const action = target.dataset.coworkAction;
    if (action === "comment") { composerOpen = true; renderAnchor(); }
    if (action === "cancel-comment") { selection = null; composerOpen = false; renderAnchor(); }
    if (action === "add-comment") submitComposer();
  };

  const onMouseOverMark = (event: MouseEvent) => {
    const mark = event.target instanceof Element ? event.target.closest<HTMLElement>("mark.cowork-mark") : null;
    if (mark) showTip(mark);
    else if (!tip.hidden) tip.hidden = true;
  };
  const onMouseLeaveArticle = () => { tip.hidden = true; };

  options.article.addEventListener("mouseup", onMouseUp);
  options.article.addEventListener("mousedown", onMouseDown);
  options.article.addEventListener("keydown", onKeyDown);
  options.article.addEventListener("click", onClick);
  options.article.addEventListener("mouseover", onMouseOverMark);
  options.article.addEventListener("mouseleave", onMouseLeaveArticle);
  // 도크가 article 밖 프레임 경계에 있으면 코드 복사 위임을 도크 존에 따로 건다.
  const dockDetached = !options.article.contains(dockZone);
  if (dockDetached) {
    dockZone.addEventListener("click", onClick);
  }

  return {
    destroy() {
      disposed = true;
      cancelRevisionRender();
      clearSettle();
      syncTick(false);
      unsubscribe?.();
      options.article.removeEventListener("mouseup", onMouseUp);
      options.article.removeEventListener("mousedown", onMouseDown);
      options.article.removeEventListener("keydown", onKeyDown);
      options.article.removeEventListener("click", onClick);
      options.article.removeEventListener("mouseover", onMouseOverMark);
      options.article.removeEventListener("mouseleave", onMouseLeaveArticle);
      if (dockDetached) {
        dockZone.removeEventListener("click", onClick);
      }
      // React 트리는 마운트 스택 밖에서 내린다 — 렌더 도중 unmount는 React가 거부한다.
      const root = threadRoot;
      threadRoot = null;
      if (root) queueMicrotask(() => root.unmount());
      anchor.remove();
      dockZone.remove();
      tip.remove();
      options.body.classList.remove("is-cowork-running");
      options.article.classList.remove("cowork-host");
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function newTurn(instruction: string, quote: string | null, commentCount: number): CoworkTurn {
  return {
    id: annotationId(),
    instruction,
    quote,
    commentCount,
    startedAt: Date.now(),
    endedAt: null,
    steps: [],
    replyHtml: "",
    hasReply: false,
    state: "pending",
    error: null,
    applied: null,
    changed: null,
  };
}

/**
 * 서버 tool 이벤트("mcp__wiki__wiki_read · running")를 스텝 행으로 접는다 — 같은 도구의
 * 갱신은 마지막 running 행을 닫고, 새 호출은 새 행을 연다. MCP 접두는 도구 이름이 아니라
 * 경로이므로 걷어낸다.
 */
function mergeStep(steps: readonly CoworkStep[], text: string): readonly CoworkStep[] {
  const [rawTitle = "", rawStatus = ""] = text.split(" · ");
  const tool = rawTitle.replace(/^mcp__[^_]+(?:_[^_]+)*__/u, "").replace(/^mcp__/u, "") || rawTitle;
  const status = rawStatus.trim();
  if (status === "running") return [...steps, { id: annotationId(), tool, status: "running" }];
  const index = [...steps].reverse().findIndex(step => step.tool === tool && step.status === "running");
  if (index < 0) return [...steps, { id: annotationId(), tool, status: status === "error" ? "error" : "done" }];
  const target = steps.length - 1 - index;
  return steps.map((step, at) => at === target ? { ...step, status: status === "error" ? "error" : "done" } : step);
}

function copyCodeToClipboard(button: HTMLElement, code: string): void {
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  let write: Promise<void>;
  try { write = clipboard.writeText(code); } catch { return; }
  const original = button.textContent;
  void write.then(() => {
    if (!button.isConnected) return;
    button.textContent = consoleT()("codex.cowork.copied");
    window.setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1_200);
  }).catch(() => undefined);
}

// 소스 라인이 아닌 "렌더된 문서" 관점의 diff — 변경 블록은 하이라이트, 삭제 블록은
// 흐림+취소선으로 문서 흐름 안에 표시된다.
function renderRenderedDiff(base: string, draft: string): string {
  return diffDraftBlocks(base, draft).map(block => {
    const html = renderMarkdown(block.markdown, { resolveWikiLink: (id) => entryPath(id), ...markdownCopyOptions(consoleT()) }).html;
    return block.kind === "same" ? html : `<div class="cowork-block cowork-block--${block.kind}">${html}</div>`;
  }).join("");
}
function annotationToDto(card: AnnotationCard): CoworkAnnotationDto { return { id: card.id, quote: card.quote, comment: card.comment.trim() || consoleT()("codex.cowork.defaultComment") }; }
function annotationFromDto(dto: CoworkAnnotationDto): AnnotationCard { return { id: dto.id, quote: dto.quote, comment: dto.comment, status: "pending" }; }
function stripFrontmatter(markdown: string): string { return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); }
function clip(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function annotationId(): string { return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
// 저장돼 있던 `cli`는 읽지 않는다 — Cowork가 Agent CLI를 고르지 않게 되면서 의미가 사라졌다.
// 목록에서 빠진 모델(fable 계열 등)의 옛 저장값도 마이그레이션이 필요 없다 — 옵션 재조회가
// 목록 밖 값을 기본값으로 되돌린다.
function readSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return { model: typeof saved.model === "string" ? saved.model : "", effort: typeof saved.effort === "string" ? saved.effort : "low" };
  } catch { return { model: "", effort: "low" }; }
}
function saveSettings(settings: Settings): void { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Storage is optional. */ } }
