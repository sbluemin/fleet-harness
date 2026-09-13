import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { HistoryBand, useHistoryReveal } from "@fleet-console/sdk/components/history-band";
import { LiveLine } from "@fleet-console/sdk/components/live-line";

import { ComposerField, ComposerInput, ComposerSubmitButton } from "@fleet-console/sdk/composer";
import { launchEtcGlyph, launchProviderFromModelId, launchProviderGlyph } from "@fleet-console/sdk/components/launch-provider-glyphs";

import { useT } from "../i18n/index.js";

/**
 * Cowork 스레드 — 문서 위에 쌓이는 턴 원장과 그 아래 컴포저.
 *
 * 문법은 터미널 플러그인의 Agent Chat과 같다: 스파인 노드가 진행(aurora)·완료(positive)·
 * 실패(coral)·검토 대기(brass)를 말하고, 도는 동안은 tally 한 줄이 지금 도는 도구를 부르며,
 * 끝난 턴은 "N초 동안 작업함" 접힘 아래로 과정을 거둔다. 상태는 컨트롤러가 소유하고 이 트리는
 * 스냅샷을 그리기만 한다 — 도크 DOM을 문자열로 재조립하던 이전 방식은 스트리밍마다 포커스를
 * 되살려야 했다.
 */

export type CoworkStepStatus = "running" | "done" | "error";
export interface CoworkStep { readonly id: string; readonly tool: string; readonly status: CoworkStepStatus; }
export type CoworkTurnState = "pending" | "running" | "complete" | "stopped" | "error";
export interface CoworkTurn {
  readonly id: string;
  readonly instruction: string;
  readonly quote: string | null;
  readonly commentCount: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly steps: readonly CoworkStep[];
  readonly replyHtml: string;
  readonly hasReply: boolean;
  readonly state: CoworkTurnState;
  readonly error: string | null;
  /** 이 턴의 초안이 항목에 적용됐을 때의 판본 이동. */
  readonly applied: { readonly from: number; readonly to: number } | null;
  /** 완료 시점의 변경 줄 수 — 턴 머리의 변경 칩이 든다. */
  readonly changed: number | null;
}

export type CoworkNoticeKind = "turn" | "stale" | "gateway" | "noModel" | "timeout" | "applied" | "generic";
export interface CoworkNotice { readonly kind: CoworkNoticeKind; readonly message: string; }
export interface CoworkAnnotationView { readonly id: string; readonly quote: string; readonly comment: string; readonly status: "pending" | "sent" | "done"; }

export interface CoworkThreadState {
  readonly locale: "en" | "ko";
  readonly turns: readonly CoworkTurn[];
  readonly running: boolean;
  /** 실행 좌표 — Settings › 실험 기능 › AI 확장 › Cowork의 값. 컴포저는 고르지 않고 보여 주기만 한다. */
  readonly model: string;
  readonly modelLabel: string;
  /** 설정의 모델이 목록에 없어(꺼진 Gateway 모델) Sonnet으로 내려간 상태. */
  readonly modelFallback: boolean;
  readonly effort: string;
  readonly annotations: readonly CoworkAnnotationView[];
  readonly panelOpen: boolean;
  readonly promptText: string;
  readonly dirty: boolean;
  readonly changed: number;
  readonly draftVersion: number;
  readonly diffVisible: boolean;
  readonly confirmAction: "apply" | "discard" | null;
  readonly notice: CoworkNotice | null;
  /** 이 턴에 붙일 시각 — 매초 갱신되는 티커의 기준. */
  readonly now: number;
}

export interface CoworkThreadActions {
  readonly onPromptChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly onOpenSettings: () => void;
  readonly onTogglePanel: () => void;
  readonly onDeleteAnnotation: (id: string) => void;
  readonly onCommentChange: (id: string, comment: string) => void;
  readonly onCommentCommit: () => void;
  readonly onDiffMode: (mode: "changes" | "full") => void;
  readonly onApplyArm: () => void;
  readonly onDiscardArm: () => void;
  readonly onConfirmBack: () => void;
  readonly onApplyConfirm: () => void;
  readonly onDiscardConfirm: () => void;
  readonly onRetry: () => void;
  readonly onDismissNotice: () => void;
}

export function CoworkThread({ state, actions }: { readonly state: CoworkThreadState; readonly actions: CoworkThreadActions }) {
  const t = useT();
  // 이력만 스크롤한다 — 리뷰 도크와 컴포저(중지·적용)는 스크롤포트 밖에 남아 언제나 손에 닿는다.
  // 스트리밍 중에는 읽던 끝을 따라간다: 사용자가 위로 올려 읽는 중이면 따라가지 않는다.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  // 이력은 마지막 문답만 보여 준다 — 앞선 턴은 상단 밴드 뒤에 접히고, 누르거나 맨 위에서 위로 한 번
  // 더 굴리면 펼쳐진다. 새 지시가 서면 다시 접히고 그 지시가 이력 상단에 앉는다.
  const [historyOpen, setHistoryOpen] = useState(false);
  // 답변 창은 접힌다. 새 지시를 보내면 펼쳐지고, 도크 바깥을 누르면 접힌다 — 읽기 본문이 다시
  // 넓어지고, 컴포저의 칩 하나가 답이 몇 개 있는지와 펼칠 길을 말한다.
  const [threadOpen, setThreadOpen] = useState(state.turns.length > 0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const earlierCount = Math.max(0, state.turns.length - 1);
  const previousTurnCountRef = useRef(state.turns.length);
  const revealHistory = useCallback(() => setHistoryOpen(true), []);
  useHistoryReveal({ ref: scrollRef, armed: !historyOpen && earlierCount > 0, onReveal: revealHistory });
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const arrived = state.turns.length > previousTurnCountRef.current;
    previousTurnCountRef.current = state.turns.length;
    if (arrived) {
      setHistoryOpen(false);
      setThreadOpen(true);
      pinnedRef.current = true;
      element.scrollTop = 0;
      return;
    }
    if (pinnedRef.current) element.scrollTop = element.scrollHeight;
  });
  useEffect(() => {
    if (!threadOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || rootRef.current?.contains(target)) return;
      setThreadOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [threadOpen]);
  const onToggleThread = useCallback(() => setThreadOpen((open) => !open), []);
  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };
  return (
    <div ref={rootRef} className="cowork-thread-root">
      {/* 답변 창의 접기·펼치기는 창 자신의 머리줄이 진다 — 이전 대화 밴드와 같은 헤어라인 한 줄이고,
          접히면 이 줄만 남아 답이 몇 개 있는지와 펼칠 길을 말한다. */}
      <div className={`cowork-thread-panel${state.turns.length > 0 || state.notice || state.panelOpen ? "" : " is-empty"}`}>
      {state.turns.length > 0 ? (
        <button
          type="button"
          className={`cowork-thread-bar${threadOpen ? " is-open" : ""}`}
          aria-expanded={threadOpen}
          onClick={onToggleThread}
        >
          <span className="cowork-thread-bar__title">{t("codex.cowork.threadTitle", { count: state.turns.length })}</span>
          <span className="cowork-thread-bar__action">{t(threadOpen ? "codex.cowork.threadHide" : "codex.cowork.threadShow")}</span>
          <span className="cowork-thread-bar__chev" aria-hidden="true">⌄</span>
        </button>
      ) : null}
      <div ref={scrollRef} className={`cowork-thread-scroll${!threadOpen && !state.notice && !state.panelOpen ? " is-folded" : ""}`} onScroll={onScroll}>
        {state.turns.length > 0 && threadOpen ? (
          <>
            <HistoryBand
              count={earlierCount}
              open={historyOpen}
              onToggle={() => setHistoryOpen((current) => !current)}
              label={t(historyOpen ? "codex.cowork.historyBandOpen" : "codex.cowork.historyBand", { count: earlierCount })}
            />
            <ol className="cowork-thread" aria-label={t("codex.cowork.threadAria")}>
              <li className="cowork-history" hidden={!historyOpen}>
                <ol className="cowork-thread">
                  {state.turns.slice(0, -1).map((turn) => (
                    <TurnView key={turn.id} turn={turn} last={false} state={state} />
                  ))}
                </ol>
              </li>
              <TurnView key={state.turns[state.turns.length - 1]!.id} turn={state.turns[state.turns.length - 1]!} last state={state} />
            </ol>
          </>
        ) : null}
        {state.notice ? <NoticeCard notice={state.notice} actions={actions} /> : null}
        {state.panelOpen ? <AnnotationPanel state={state} actions={actions} /> : null}
      </div>
      </div>
      {state.dirty && !state.running ? <ReviewDock state={state} actions={actions} /> : null}
      <Composer state={state} actions={actions} />
    </div>
  );
}

// ── 빈 상태 ─────────────────────────────────────────────────────────────────


// ── 턴 ──────────────────────────────────────────────────────────────────────

function TurnView({ turn, last, state }: { readonly turn: CoworkTurn; readonly last: boolean; readonly state: CoworkThreadState }) {
  const t = useT();
  const working = turn.state === "running" || turn.state === "pending";
  const reviewing = last && state.dirty && !state.running && turn.state === "complete" && !turn.applied;
  const tone = working ? "is-working" : turn.state === "error" ? "is-error" : turn.state === "stopped" ? "is-stopped" : reviewing ? "is-review" : turn.applied ? "is-applied" : "is-complete";
  const runningStep = turn.steps.find((step) => step.status === "running") ?? null;
  const elapsedMs = (turn.endedAt ?? state.now) - turn.startedAt;
  const duration = formatDuration(elapsedMs, state.locale);
  const liveLabel = runningStep
    ? t("codex.cowork.toolRunning", { tool: runningStep.tool })
    : turn.hasReply
      ? t("codex.cowork.writingAnswer")
      : t("codex.cowork.thinking");
  const showFold = !working && turn.steps.length > 0;
  return (
    <li className={`cowork-turn ${tone}`}>
      <div className="cowork-turn-body">
        <div className="cowork-dispatch">
          {turn.quote ? <q className="cowork-dispatch-quote">{turn.quote}</q> : null}
          <span className="cowork-dispatch-text">{turn.instruction}</span>
        </div>
        {/* 도는 동안은 Live line 한 줄뿐이다 — 지금 도는 도구와 스텝 수·경과가 제자리에서 갱신되고,
            과정 전체는 끝난 뒤 접힘을 펼쳐야 나온다(채팅뷰·분석가·부관과 같은 문법). */}
        {working ? (
          <LiveLine
            label={liveLabel}
            thinking={!runningStep && !turn.hasReply}
            meta={`${turn.steps.length > 0 ? `${t("codex.cowork.stepCount", { count: turn.steps.length })} · ` : ""}${duration}`}
          />
        ) : null}
        {showFold ? (
          <details className="cowork-fold">
            <summary className="cowork-fold-summary">
              <span>{turn.state === "stopped" ? t("codex.cowork.workedForStopped", { duration }) : t("codex.cowork.workedFor", { duration })}</span>
              <span className="cowork-fold-sep">·</span>
              <span>{t("codex.cowork.stepCount", { count: turn.steps.length })}</span>
              <span className="cowork-fold-chev" aria-hidden="true">›</span>
            </summary>
            <div className="cowork-steps cowork-steps--folded">{turn.steps.map((step) => <StepRow key={step.id} step={step} />)}</div>
          </details>
        ) : !working && turn.state === "stopped" ? (
          <p className="cowork-fold-summary cowork-fold-summary--static">{t("codex.cowork.workedForStopped", { duration })}</p>
        ) : null}
        {turn.hasReply || turn.applied ? (
          <div className={`cowork-answer${working ? " is-streaming" : ""}`}>
            <div className="cowork-answer-kicker">
              {turn.applied ? t("codex.cowork.appliedKicker", { from: turn.applied.from, to: turn.applied.to }) : t("codex.cowork.answer")}
            </div>
            {turn.hasReply ? (
              <div className="cowork-answer-body markdown-body" dangerouslySetInnerHTML={{ __html: turn.replyHtml }} />
            ) : null}
          </div>
        ) : null}
        {turn.state === "stopped" ? <p className="cowork-turn-note">{t("codex.cowork.stoppedNote")}</p> : null}
        {turn.changed !== null && turn.changed > 0 && !working ? (
          <div className="cowork-changes">
            <span className="cowork-change">
              {t(turn.changed === 1 ? "codex.cowork.changedLines_one" : "codex.cowork.changedLines_other", { count: turn.changed })}
            </span>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function StepRow({ step }: { readonly step: CoworkStep }) {
  return (
    <div className={`cowork-step is-${step.status}`}>
      {step.status === "running"
        ? <span className="cowork-orbit" aria-hidden="true" />
        : <span className="cowork-step-mark" aria-hidden="true">{step.status === "error" ? "✕" : "✓"}</span>}
      <span className="cowork-step-object">{step.tool}</span>
    </div>
  );
}

// ── 알림 카드 ─────────────────────────────────────────────────────────────────

function NoticeCard({ notice, actions }: { readonly notice: CoworkNotice; readonly actions: CoworkThreadActions }) {
  const t = useT();
  const tone = notice.kind === "turn" || notice.kind === "generic" ? "is-error" : notice.kind === "applied" ? "is-applied" : "is-warn";
  return (
    <div className={`cowork-sys ${tone}`} role={tone === "is-error" ? "alert" : "status"}>
      <span className="cowork-sys-text">{notice.message}</span>
      {notice.kind === "turn" ? <button type="button" className="cowork-sys-action" onClick={actions.onRetry}>{t("codex.cowork.retry")}</button> : null}
      <button type="button" className="cowork-sys-dismiss" aria-label={t("common.close")} onClick={actions.onDismissNotice}>×</button>
    </div>
  );
}

// ── 댓글 패널 ─────────────────────────────────────────────────────────────────

function AnnotationPanel({ state, actions }: { readonly state: CoworkThreadState; readonly actions: CoworkThreadActions }) {
  const t = useT();
  return (
    <div className="cowork-panel" role="region" aria-label={t("codex.cowork.annotationsAria")}>
      {state.annotations.length === 0 ? <p className="cowork-empty">{t("codex.cowork.emptyAnnotations")}</p> : state.annotations.map((card) => (
        <article key={card.id} className={`cowork-card is-${card.status}`}>
          <blockquote>{clip(card.quote, 160)}</blockquote>
          <textarea
            data-cowork-comment={card.id}
            aria-label={t("codex.cowork.commentAria")}
            placeholder={t("codex.cowork.addCommentPlaceholder")}
            disabled={card.status === "sent"}
            value={card.comment}
            onChange={(event) => actions.onCommentChange(card.id, event.target.value)}
            onBlur={actions.onCommentCommit}
          />
          <footer>
            <span className="cowork-card-status">{card.status === "sent" ? t("codex.cowork.statusSent") : card.status === "done" ? t("codex.cowork.statusDone") : t("codex.cowork.statusReady")}</span>
            <button type="button" className="cowork-x" aria-label={t("codex.cowork.deleteAnnotation")} onClick={() => actions.onDeleteAnnotation(card.id)}>×</button>
          </footer>
        </article>
      ))}
    </div>
  );
}

// ── 리뷰 도크 ─────────────────────────────────────────────────────────────────

function ReviewDock({ state, actions }: { readonly state: CoworkThreadState; readonly actions: CoworkThreadActions }) {
  const t = useT();
  if (state.confirmAction) {
    const apply = state.confirmAction === "apply";
    return (
      <div className="cowork-review is-confirm">
        <span className="cowork-review-text">{apply ? t("codex.cowork.applyConfirm") : t("codex.cowork.discardConfirm")}</span>
        <button type="button" className={`cowork-solid${apply ? "" : " cowork-solid--danger"}`} onClick={apply ? actions.onApplyConfirm : actions.onDiscardConfirm}>
          {apply ? t("codex.cowork.apply") : t("codex.cowork.discard")}
        </button>
        <button type="button" className="cowork-ghost" onClick={actions.onConfirmBack}>{t("codex.cowork.back")}</button>
      </div>
    );
  }
  const changedLabel = state.changed > 0
    ? t(state.changed === 1 ? "codex.cowork.changedLines_one" : "codex.cowork.changedLines_other", { count: state.changed })
    : t("codex.cowork.removedContent");
  return (
    <div className="cowork-review">
      <span className="cowork-review-text">
        <b>{t("codex.cowork.draftVersion", { version: state.draftVersion })}</b>
        <span className="cowork-review-sep">·</span>{changedLabel}
        <span className="cowork-review-sep">·</span>{t("codex.cowork.beforeApply")}
      </span>
      <span className="cowork-segments" role="group" aria-label={t("codex.cowork.diffModeAria")}>
        <button type="button" aria-pressed={state.diffVisible} onClick={() => actions.onDiffMode("changes")}>{t("codex.cowork.viewDiff")}</button>
        <button type="button" aria-pressed={!state.diffVisible} onClick={() => actions.onDiffMode("full")}>{t("codex.cowork.viewDraft")}</button>
      </span>
      <button type="button" className="cowork-solid" onClick={actions.onApplyArm}>{t("codex.cowork.apply")}</button>
      <button type="button" className="cowork-ghost" onClick={actions.onDiscardArm}>{t("codex.cowork.discard")}</button>
    </div>
  );
}

// ── 컴포저 ───────────────────────────────────────────────────────────────────

function Composer({ state, actions }: { readonly state: CoworkThreadState; readonly actions: CoworkThreadActions }) {
  const t = useT();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingComments = state.annotations.filter((card) => card.status !== "done").length;
  // 도는 동안에도 입력은 열려 있다 — Esc 중지의 초점 자리이고, 다음 지시를 미리 써 둘 수 있다.
  // 전송만 canSend가 막는다.
  const placeholder = state.running
    ? t("codex.cowork.queueHint")
    : pendingComments > 0
      ? t("codex.cowork.instructionOptional", { count: pendingComments })
      : state.dirty ? t("codex.cowork.continueDraft") : t("codex.cowork.askAi");
  const canSend = !state.running && (state.promptText.trim().length > 0 || pendingComments > 0);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) actions.onSend();
      return;
    }
    if (event.key === "Escape" && state.running) {
      event.preventDefault();
      event.stopPropagation();
      actions.onStop();
    }
  };
  const provider = launchProviderFromModelId(state.model);
  const effortLabel = state.effort ? state.effort.toUpperCase() : "";
  const hint = state.running ? t("codex.cowork.hintStop") : `${t("codex.cowork.hintSend")} · ${t("codex.cowork.hintNewline")}`;
  return (
    <div className="cowork-composer-stack">
      {/* 모델 표시줄 — 상자 밖 한 줄. 컴포저는 좌표를 고르지 않으므로 무엇으로 도는지와 바꾸는 길만 말한다. */}
      <div className="cowork-composer-meta">
        <span className="cowork-composer-model" title={t("codex.cowork.modelFrom")}>
          <span className={`cowork-composer-model-mark operation-launch-provider-glyph${provider ? ` is-${provider}` : " operation-launch-provider-glyph--etc"}`} aria-hidden="true">
            {provider ? launchProviderGlyph(provider) : launchEtcGlyph()}
          </span>
          <span className="cowork-composer-model-label">{state.modelLabel || state.model || "—"}</span>
          {effortLabel ? <span className="cowork-composer-model-effort">{effortLabel}</span> : null}
          {state.modelFallback ? <span className="cowork-composer-model-fallback">{t("codex.cowork.modelFallback")}</span> : null}
        </span>
        <button type="button" className="cowork-composer-settings" onClick={actions.onOpenSettings}>{t("codex.cowork.changeInSettings")}</button>
      </div>
      {/* 상자 어디를 눌러도(버튼 제외) 입력이 초점을 받는다 — 상자 자체가 입력의 표적이다. */}
      <div
        className={`cowork-composer-frame${state.running ? " is-working" : ""}`}
        onMouseDown={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("button, textarea, a")) return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        {/* 한 줄 컴포저 — 앞 슬롯(댓글 칩, 있을 때만) · 입력 · 뒤 동작(전송/중지)이 한 면 안에 앉는다.
           입력이 여러 줄로 자라도 슬롯과 동작은 아래 변에 남는다(align-items: flex-end). */}
        <ComposerField className="cowork-composer-field">
          {state.annotations.length > 0 || state.panelOpen ? (
            <button
              type="button"
              className={`cowork-chip cowork-composer-lead${state.panelOpen ? " is-active" : ""}`}
              aria-expanded={state.panelOpen}
              aria-label={t("codex.cowork.annotationsAria")}
              disabled={state.running}
              onClick={actions.onTogglePanel}
            >
              <span aria-hidden="true">✦</span>{state.annotations.length}
            </button>
          ) : null}
          <ComposerInput
            ref={inputRef}
            className="cowork-composer-input"
            name="prompt"
            rows={1}
            value={state.promptText}
            placeholder={placeholder}
            aria-label={t("codex.cowork.instructionAria")}
            onChange={(event) => actions.onPromptChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {state.running ? (
            <button type="button" className="cowork-send cowork-stop" aria-label={t("codex.cowork.stopAria")} title={hint} onClick={actions.onStop}>
              <span aria-hidden="true" />
            </button>
          ) : (
            <ComposerSubmitButton className={`cowork-send${canSend ? " is-armed" : ""}`} aria-label={t("codex.cowork.sendToAi")} title={hint} disabled={!canSend} onClick={actions.onSend} />
          )}
        </ComposerField>
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number, locale: "en" | "ko"): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return locale === "ko" ? `${seconds}초` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return locale === "ko" ? `${minutes}분 ${rest}초` : `${minutes}m ${rest}s`;
}


function clip(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
