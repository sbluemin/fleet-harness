import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import { ComposerBar, ComposerField, ComposerInput, ComposerSubmitButton, EffortTrack } from "@fleet-console/sdk/composer";
import {
  groupModelsByLaunchProvider,
  launchEtcGlyph,
  launchProviderCaption,
  launchProviderFromModelId,
  launchProviderGlyph,
} from "@fleet-console/sdk/components/launch-provider-glyphs";

import { useT } from "../i18n/index.js";
import type { CoworkModelRow } from "./api.js";

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
  readonly models: readonly CoworkModelRow[];
  readonly efforts: readonly string[];
  readonly model: string;
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
  readonly onSelectModel: (model: string) => void;
  readonly onSelectEffort: (effort: string) => void;
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
  readonly onSuggest: (text: string) => void;
  readonly onRetry: () => void;
  readonly onDismissNotice: () => void;
}

export function CoworkThread({ state, actions }: { readonly state: CoworkThreadState; readonly actions: CoworkThreadActions }) {
  const t = useT();
  // 초안이 살아 있으면(복원된 세션) 빈 화면이 아니다 — 리뷰 도크가 그 자리를 진다.
  const empty = state.turns.length === 0 && state.annotations.length === 0 && !state.running && !state.dirty;
  return (
    <div className="cowork-thread-root">
      {empty ? <EmptyHero onSuggest={actions.onSuggest} /> : null}
      {state.turns.length > 0 ? (
        <ol className="cowork-thread" aria-label={t("codex.cowork.threadAria")}>
          {state.turns.map((turn, index) => (
            <TurnView key={turn.id} turn={turn} last={index === state.turns.length - 1} state={state} />
          ))}
        </ol>
      ) : null}
      {state.notice ? <NoticeCard notice={state.notice} actions={actions} /> : null}
      {state.panelOpen ? <AnnotationPanel state={state} actions={actions} /> : null}
      {state.dirty && !state.running ? <ReviewDock state={state} actions={actions} /> : null}
      <Composer state={state} actions={actions} />
    </div>
  );
}

// ── 빈 상태 ─────────────────────────────────────────────────────────────────

function EmptyHero({ onSuggest }: { readonly onSuggest: (text: string) => void }) {
  const t = useT();
  const suggestions = [
    t("codex.cowork.suggestStale"),
    t("codex.cowork.suggestLinks"),
    t("codex.cowork.suggestCode"),
    t("codex.cowork.suggestSummary"),
  ];
  return (
    <div className="cowork-hero">
      <span className="cowork-hero-sigil" aria-hidden="true">✳</span>
      <h2 className="cowork-hero-title">{t("codex.cowork.emptyTitle")}</h2>
      <p className="cowork-hero-body">{t("codex.cowork.emptyBody")}</p>
      <div className="cowork-hero-suggestions">
        {suggestions.map((text) => (
          <button key={text} type="button" className="cowork-hero-suggestion" onClick={() => onSuggest(text)}>{text}</button>
        ))}
      </div>
    </div>
  );
}

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
      <div className="cowork-turn-spine" aria-hidden="true"><span className="cowork-turn-node" /></div>
      <div className="cowork-turn-body">
        <div className="cowork-turn-head">
          <span className="cowork-turn-who">{t("codex.cowork.you")}</span>
          <span className="cowork-turn-time">{formatClock(turn.startedAt, state.locale)}</span>
        </div>
        <div className="cowork-dispatch">
          {turn.quote ? <q className="cowork-dispatch-quote">{turn.quote}</q> : null}
          <span className="cowork-dispatch-text">{turn.instruction}</span>
        </div>
        {working ? (
          <div className="cowork-tally" role="status" aria-live="polite">
            <span className="cowork-orbit" aria-hidden="true" />
            <span className="cowork-live-text">{liveLabel}</span>
            {!runningStep && !turn.hasReply ? <ThinkingDots /> : null}
            {turn.steps.length > 0 ? <span className="cowork-tally-count">· {t("codex.cowork.stepCount", { count: turn.steps.length })}</span> : null}
          </div>
        ) : null}
        {working && turn.steps.length > 0 ? (
          <div className="cowork-steps">{turn.steps.slice(-3).map((step) => <StepRow key={step.id} step={step} />)}</div>
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

function ThinkingDots() {
  return <span className="cowork-thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>;
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
  const selectedRow = state.models.find((row) => row.id === state.model) ?? null;
  const trackRow: OperationLaunchVariantRow = {
    id: "cowork-effort",
    label: t("launchVariants.effort.track"),
    launch: {},
    chips: state.efforts.map((id) => ({ id, label: id.toUpperCase(), launch: {} })),
    effortAxis: [...state.efforts],
  };
  return (
    <div className={`cowork-composer-frame${state.running ? " is-working" : ""}`}>
      <ComposerField className="cowork-composer-field">
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
      </ComposerField>
      <ComposerBar className="cowork-composer-bar">
        {state.annotations.length > 0 || state.panelOpen ? (
          <button
            type="button"
            className={`cowork-chip${state.panelOpen ? " is-active" : ""}`}
            aria-expanded={state.panelOpen}
            aria-label={t("codex.cowork.annotationsAria")}
            disabled={state.running}
            onClick={actions.onTogglePanel}
          >
            <span aria-hidden="true">✦</span>{state.annotations.length}
          </button>
        ) : null}
        <ModelChip
          models={state.models}
          value={state.model}
          selected={selectedRow}
          disabled={state.running}
          label={t("codex.cowork.agentSettingsAria")}
          menuLabel={t("codex.cowork.modelMenuAria")}
          etcLabel={t("codex.cowork.modelGroupEtc")}
          onChange={actions.onSelectModel}
        />
        {state.efforts.length > 0 ? (
          <span className="cowork-effort" inert={state.running || undefined}>
            <EffortTrack
              row={trackRow}
              value={state.efforts.includes(state.effort) ? state.effort : state.efforts[0] ?? null}
              onChange={(next) => { if (next !== null) actions.onSelectEffort(next); }}
              autoLabel={t("launchVariants.effort.auto")}
              autoSlot={false}
              ariaLabel={t("launchVariants.effort.track")}
              autoValueText={t("launchVariants.effort.autoValue")}
              className="cowork-effort-track"
            />
          </span>
        ) : null}
        <span className="cowork-composer-hint" aria-hidden="true">
          {state.running ? t("codex.cowork.hintStop") : `${t("codex.cowork.hintSend")} · ${t("codex.cowork.hintNewline")}`}
        </span>
        {state.running ? (
          <button type="button" className="cowork-send cowork-stop" aria-label={t("codex.cowork.stopAria")} title={t("codex.cowork.stopAria")} onClick={actions.onStop}>
            <span aria-hidden="true" />
          </button>
        ) : (
          <ComposerSubmitButton className={`cowork-send${canSend ? " is-armed" : ""}`} aria-label={t("codex.cowork.sendToAi")} title={t("codex.cowork.sendToAi")} disabled={!canSend} onClick={actions.onSend} />
        )}
      </ComposerBar>
    </div>
  );
}

// ── 모델 칩 + 포털 메뉴 (Analyst 구성을 옮긴다 — 렌더러는 공유하지 않는다) ────────

const MENU_MAX_HEIGHT = 520;
const MENU_MIN_HEIGHT = 120;
const MENU_MARGIN = 12;
const MENU_GAP = 8;
const MENU_WIDTH = 216;

function placeMenu(chip: HTMLElement): CSSProperties {
  const rect = chip.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - rect.bottom - MENU_GAP - MENU_MARGIN;
  const spaceAbove = rect.top - MENU_GAP - MENU_MARGIN;
  // 도크는 화면 아래에 서므로 대개 위로 연다 — 아래 공간이 충분할 때만 아래로.
  const openBelow = spaceBelow >= MENU_MIN_HEIGHT && spaceBelow >= spaceAbove;
  const maxHeight = Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, openBelow ? spaceBelow : spaceAbove));
  const width = Math.min(MENU_WIDTH, viewportWidth - MENU_MARGIN * 2);
  const left = Math.min(Math.max(MENU_MARGIN, rect.left), viewportWidth - width - MENU_MARGIN);
  const top = openBelow ? rect.bottom + MENU_GAP : Math.max(MENU_MARGIN, rect.top - MENU_GAP - maxHeight);
  return { position: "fixed", top, left, zIndex: 40, width, maxHeight, overflowY: "auto" };
}

function ModelChip({ models, value, selected, disabled, label, menuLabel, etcLabel, onChange }: {
  readonly models: readonly CoworkModelRow[];
  readonly value: string;
  readonly selected: CoworkModelRow | null;
  readonly disabled: boolean;
  readonly label: string;
  readonly menuLabel: string;
  readonly etcLabel: string;
  readonly onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const selectedProvider = launchProviderFromModelId(selected?.id ?? value);
  const groups = groupModelsByLaunchProvider(models);
  useLayoutEffect(() => {
    if (!open || !chipRef.current) return;
    setMenuStyle(placeMenu(chipRef.current));
  }, [open, models]);
  useEffect(() => {
    if (!open) return;
    // 열리면 체크된 항목으로 초점 — 메뉴 버튼 관례(Quick Launch·Analyst와 같다).
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (chipRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      chipRef.current?.focus();
    };
    const onReposition = () => { if (chipRef.current) setMenuStyle(placeMenu(chipRef.current)); };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`cowork-model-chip${selectedProvider ? ` is-${selectedProvider}` : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        data-cowork-model={value}
        onClick={() => { if (!disabled) setOpen((current) => !current); }}
      >
        <span className="cowork-model-mark operation-launch-provider-glyph" aria-hidden="true">
          {selectedProvider ? launchProviderGlyph(selectedProvider) : launchEtcGlyph()}
        </span>
        <span className="cowork-model-chip-label">{selected?.label ?? (value || "—")}</span>
        <span className="cowork-model-chip-caret" aria-hidden="true">▾</span>
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
          <div ref={menuRef} className="cowork-model-menu theater-menu" role="menu" aria-label={menuLabel} style={menuStyle} onKeyDown={onMenuKeyDown}>
            {groups.map((group, groupIndex) => {
              const caption = group.provider ? launchProviderCaption(group.provider) : etcLabel;
              return (
                <div key={group.provider ?? "etc"} role="group" aria-label={caption}>
                  {groupIndex > 0 ? <div className="theater-menu-divider" role="separator" /> : null}
                  <p className={`operation-launch-variant-caption${group.provider ? ` is-${group.provider}` : ""}`}>
                    <span className={`operation-launch-provider-glyph${group.provider ? "" : " operation-launch-provider-glyph--etc"}`} aria-hidden="true">
                      {group.provider ? launchProviderGlyph(group.provider) : launchEtcGlyph()}
                    </span>
                    <span>{caption}</span>
                  </p>
                  {group.models.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="operation-launch-variant-row"
                      role="menuitemradio"
                      aria-checked={item.id === value}
                      data-cowork-model-option={item.id}
                      onClick={() => { onChange(item.id); setOpen(false); chipRef.current?.focus(); }}
                    >
                      <span className="operation-launch-variant-row-label">{item.label}</span>
                      {item.id === value ? <span className="cowork-model-check" aria-hidden="true">✓</span> : null}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>,
          document.body,
        )
        : null}
    </>
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

function formatClock(at: number, locale: "en" | "ko"): string {
  try {
    return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
  } catch {
    return "";
  }
}

function clip(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
