import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import { MAX_CONTEXT, type ObjectiveEditKind, type ObjectiveItem } from "../server/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 하단 한 자리 — 지금 할 한 가지를 말한다. 같은 상태에서 함께 성립하는 다른 한 가지는 버튼을 늘리지 않고, 누르면 이 자리가
 * 위로 펼쳐져 그 안에서 고른다. 지휘관에게 말을 거는 행동(구상·개시·스티어링)은 모두 같은 칸으로 덧붙일 말을 받는다.
 * 완료·결정 대기·중단은 펼칠 것이 없으면 누르는 즉시 실행한다.
 *
 * 우선순위 — 사람이 지금 무엇을 해야 하나: 완료됨 > 지휘관 결정 대기 > 작업 중(구성원 실행 포함) > 구성원 결정 대기 >
 * 검토 대기 > 깨운 뒤 유휴 > 개시 전. 지휘관이 마지막으로 읽은 뒤 사람이 보드를 고쳤으면 낱말은 상태와 상관없이 「스티어링」이고,
 * 서버 경로는 상태가 고른다(쉬는 구성원까지 깨워야 하는 유휴는 개시 경로, 작업 중·검토 대기·구상 중은 스티어링 경로).
 * 달성 기준 제안이 남아 있으면 개시·스티어링은 잠긴 띠로 서고(서버가 criteria_pending 으로 거부한다), 그 아래 「다시 구상」만 열린다.
 */

type IntentKey = "plan" | "replan" | "start" | "resume" | "steer" | "steerIdle" | "complete" | "decide" | "decideMember" | "stop";

interface Intent {
  readonly word: string;
  readonly desc: string;
  /** 지휘관에게 말을 건다 — 덧붙일 말을 받는다. */
  readonly talk: boolean;
  readonly tone?: "stop" | "aurora";
  readonly glyph?: ReactNode;
  readonly placeholder?: string;
  readonly run: (context: string) => Promise<unknown>;
}

export interface MemberAwaiting {
  readonly operationId: string;
  readonly role: string;
  /** 그 구성원이 맡은 끝나지 않은 첫 임무의 번호(1부터). 없으면 null. */
  readonly mission: number | null;
}

export interface ActionBandProps {
  readonly item: ObjectiveItem;
  readonly t: T;
  /** 지휘관이 일한다(running·background, 구성원 활동을 끌어올린 값) — 편집 잠금과 같은 기준. */
  readonly busy: boolean;
  /** 지휘관 자신이나 구성원 누군가가 일한다. */
  readonly working: boolean;
  /** 지휘관 자신이 사람의 결정을 기다린다(끌어올리기 전 값 — 구성원의 대기는 memberAwaiting). */
  readonly commanderAwaiting: boolean;
  readonly memberAwaiting: MemberAwaiting | null;
  readonly launchAvailable: boolean;
  /** 지휘관 상태 낱말(유휴·끝남 …) — 「개시」 부제에 쓴다. */
  readonly commanderState: string;
  /** 실패하면 코드를 message 로 던진다. */
  readonly request: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  readonly onFocusOperation: (operationId: string) => void;
}

const WandGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 13l7-7M10 3l.6 1.6L12.2 5l-1.6.6L10 7.2 9.4 5.6 7.8 5l1.6-.6zM13 9l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z" /></svg>;
const StartGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 3.5l8 4.5-8 4.5z" /></svg>;
const SteerGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 11.5c2-4 5-6 11-6M10.5 2.5l3 3-3 3" /></svg>;
const LockGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>;
const StopGlyph = () => <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>;
const CloseGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>;
const DecideDot = () => <i className="objectives-start-dot" aria-hidden="true" />;
/** 카드 이동(objectives-panel.tsx의 GoGlyph)과 같은 path — 크기는 CSS가 정한다. */
const GoGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5H3.5v9h9V10M9.5 3.5h3v3M12.5 3.5 7.5 8.5" /></svg>;

const COUNT_FROM = 1800;
/**
 * 초안 — 접어도, 다른 목표를 보다 와도, 레일↔확대로 자리를 옮겨도 남는다(목표 id 별, 이 탭의 메모리). 보내면 비운다.
 * 플러그인 번들 안에서만 쓰는 보기 상태라 호스트와 나누지 않는다.
 */
const drafts = new Map<string, string>();
/** 한글 IME 조합 중의 Enter 와 길게 눌러 반복된 Enter 는 보내지 않는다. Shift+Enter 는 줄바꿈이다. */
const sendKey = (event: ReactKeyboardEvent<HTMLElement>): boolean => event.key === "Enter" && !event.shiftKey && !event.repeat && !event.nativeEvent.isComposing && event.keyCode !== 229;

const EDIT_KEYS: Readonly<Record<ObjectiveEditKind, ObjectiveMessageKey>> = {
  title: "objectives.edit.title",
  note: "objectives.edit.note",
  steps: "objectives.edit.steps",
  recipe: "objectives.edit.recipe",
  members: "objectives.edit.members",
  assign: "objectives.edit.assign",
  criteria: "objectives.edit.criteria",
};

const REASONS: Readonly<Record<string, ObjectiveMessageKey>> = {
  item_busy: "objectives.band.reason.busy",
  slot_taken: "objectives.band.reason.taken",
  session_awaiting_input: "objectives.band.reason.awaiting",
  launch_failed: "objectives.band.reason.undelivered",
  launch_unavailable: "objectives.band.reason.unavailable",
  item_done: "objectives.band.reason.done",
  criteria_pending: "objectives.band.reason.criteriaPending",
  criteria_not_planning: "objectives.band.reason.criteriaNotPlanning",
};

/** 지금 상태의 주행동과, 펼치면 함께 고르는 것. 제안이 남아 잠긴 개시·스티어링은 gated 가 말한다(주행동은 「다시 구상」). */
function choose(props: ActionBandProps): { readonly primary: IntentKey | null; readonly alts: readonly IntentKey[]; readonly gated?: true } {
  const { item, working, commanderAwaiting, memberAwaiting } = props;
  if (item.done) return { primary: null, alts: [] };
  const started = item.commander.started;
  // 한 번도 깨지 않은 지휘관은 보드를 처음부터 읽는다 — 그 전의 편집은 알릴 것이 아니다.
  const edited = started && (item.edited?.kinds.length ?? 0) > 0;
  if (commanderAwaiting) return { primary: "decide", alts: [] };
  if (working) return edited ? { primary: "steer", alts: ["stop"] } : { primary: "stop", alts: [] };
  if (memberAwaiting) return { primary: "decideMember", alts: [] };
  if (item.criteriaProposals.length > 0) return { primary: "replan", alts: [], gated: true };
  if (item.awaitingReview) return edited ? { primary: "steer", alts: ["replan"] } : { primary: "complete", alts: [] };
  // 구상이 끝나 개시를 기다린다 — 편집이 있으면 편성을 이어서 짜게 알리고(스티어링), 개시도 여기서 고른다.
  if (started && item.cooking) return edited ? { primary: "steer", alts: ["start"] } : { primary: "start", alts: ["replan"] };
  if (started) return edited ? { primary: "steerIdle", alts: ["replan"] } : { primary: "resume", alts: ["replan"] };
  return item.steps.length === 0 ? { primary: "plan", alts: ["start"] } : { primary: "start", alts: ["plan"] };
}

export function ActionBand(props: ActionBandProps) {
  const { item, t, request } = props;
  const { primary, alts, gated } = choose(props);
  const choices: readonly IntentKey[] = primary ? [primary, ...alts] : [];
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<IntentKey | null>(null);
  const [draft, setDraftState] = useState(() => drafts.get(item.id) ?? "");
  const setDraft = (next: string) => { if (next) drafts.set(item.id, next); else drafts.delete(item.id); setDraftState(next); };
  // 보내는 중인 할 일 — 응답이 오기 전에 상태(사다리)가 먼저 바뀌어도 띠는 지금 진행 중인 그 행동을 말한다.
  // 예: 「중단」은 서버가 구상 국면을 먼저 풀어 사다리가 곧바로 「개시」가 되지만, 응답(중단 확인)은 한참 뒤에 온다.
  const [pending, setPending] = useState<IntentKey | null>(null);
  const sending = pending !== null;
  const [error, setError] = useState<string | null>(null);
  const bandRef = useRef<HTMLButtonElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const compRef = useRef<HTMLDivElement | null>(null);

  const kinds = (item.edited?.kinds ?? []).map((kind) => t(EDIT_KEYS[kind]));
  const kindText = kinds.join("·");
  const itemId = item.id;
  const members = item.members.length;
  const proposals = item.criteriaProposals.length;
  const annotated = item.criteriaProposals.filter((proposal) => !!proposal.annotation).length;
  const replanDesc = gated ? (annotated ? t("objectives.band.replan.annotated", { count: annotated }) : t("objectives.band.replan.pending")) : t("objectives.band.replan.desc");
  const intents: Record<IntentKey, Intent> = {
    plan: { word: t("objectives.band.plan"), desc: t("objectives.band.plan.desc"), talk: true, glyph: <WandGlyph />, placeholder: t("objectives.coordinator.cookContext"), run: (context) => request("/plan/request", { itemId, context }) },
    replan: { word: t("objectives.band.replan"), desc: replanDesc, talk: true, glyph: <WandGlyph />, placeholder: t("objectives.band.replan.ph"), run: (context) => request("/plan/request", { itemId, context }) },
    start: { word: t("objectives.coordinator.start"), desc: members ? t("objectives.start.members", { count: members }) : item.steps.length ? t("objectives.start.direct") : t("objectives.band.start.bare"), talk: true, glyph: <StartGlyph />, placeholder: t("objectives.band.start.ph"), run: (context) => request("/coordinator/start", { itemId, ...(context ? { context } : {}) }) },
    resume: { word: t("objectives.coordinator.start"), desc: `${props.commanderState} · ${t("objectives.start.resume")}`, talk: true, glyph: <StartGlyph />, placeholder: t("objectives.band.resume.ph"), run: (context) => request("/coordinator/start", { itemId, ...(context ? { context } : {}) }) },
    steer: {
      word: t("objectives.steer"),
      desc: item.cooking && !props.working ? t("objectives.band.steer.planning", { kinds: kindText }) : `${t("objectives.band.steer.desc", { kinds: kindText })}${item.awaitingReview ? t("objectives.band.steer.review") : ""}`,
      talk: true, glyph: <SteerGlyph />, placeholder: t("objectives.band.steer.ph"),
      run: (context) => request("/coordinator/steer", { itemId, ...(context ? { context } : {}) }),
    },
    steerIdle: { word: t("objectives.steer"), desc: t("objectives.band.steerIdle.desc", { kinds: kindText }), talk: true, glyph: <SteerGlyph />, placeholder: t("objectives.band.steer.ph"), run: (context) => request("/coordinator/start", { itemId, ...(context ? { context } : {}) }) },
    complete: { word: t("objectives.review.complete"), desc: t(item.criteria.length > 0 ? "objectives.review.subCriteria" : "objectives.review.sub"), talk: false, tone: "aurora", run: () => request("/item/complete", { itemId }) },
    decide: { word: t("objectives.awaiting.word"), desc: t("objectives.awaiting.commander"), talk: false, tone: "aurora", glyph: <DecideDot />, run: async () => props.onFocusOperation(itemId) },
    decideMember: {
      word: t("objectives.awaiting.word"),
      desc: props.memberAwaiting?.mission ? t("objectives.band.decideMemberMission", { role: props.memberAwaiting.role, index: props.memberAwaiting.mission }) : t("objectives.band.decideMember", { role: props.memberAwaiting?.role ?? "" }),
      talk: false, tone: "aurora", glyph: <DecideDot />,
      run: async () => { if (props.memberAwaiting) props.onFocusOperation(props.memberAwaiting.operationId); },
    },
    stop: { word: t("objectives.stop"), desc: item.cooking && props.busy ? t("objectives.band.stopPlanning") : t("objectives.stopHint"), talk: false, tone: "stop", glyph: <StopGlyph />, run: () => request("/coordinator/stop", { itemId }) },
  };

  // 펼친 사이 상태가 바뀌어 고른 할 일이 사라지면 — 주행동이 말 거는 행동이면 그리로 옮기고, 아니면 접는다(초안은 남는다).
  useEffect(() => {
    if (pending || !open || !intent || choices.includes(intent)) return;
    if (primary && intents[primary].talk) setIntent(primary);
    else setOpen(false);
  });
  // 초안이 늘면 칸도 는다 — 최대 132px 뒤로는 안에서 스크롤.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "0px";
    field.style.height = `${Math.min(field.scrollHeight, 132)}px`;
  }, [draft, open, intent]);

  if (!primary && !pending) return null;
  const current = open && intent ? intents[intent] : null;
  const unavailable = (key: IntentKey) => intents[key].talk && !props.launchAvailable;

  const pick = (key: IntentKey, focus: "field" | "radio") => {
    setIntent(key);
    setError(null);
    // 구상의 맥락은 목표에 남아 있다 — 칸이 비었으면 지난번 말로 미리 채운다.
    if ((key === "plan" || key === "replan") && !draft && item.cook) setDraft(item.cook);
    requestAnimationFrame(() => {
      if (focus === "field" && intents[key].talk) { const field = fieldRef.current; if (field && !field.disabled) { field.focus(); field.setSelectionRange(field.value.length, field.value.length); } }
      else compRef.current?.querySelector<HTMLElement>(`[data-intent="${key}"]`)?.focus();
    });
  };
  const fold = (focusBand: boolean) => {
    setOpen(false);
    setError(null);
    if (focusBand) requestAnimationFrame(() => bandRef.current?.focus());
  };
  const run = async (key: IntentKey) => {
    const chosen = intents[key];
    if (sending || unavailable(key)) return;
    setPending(key);
    setError(null);
    try {
      await chosen.run(chosen.talk ? draft.trim() : "");
      if (chosen.talk) setDraft("");
      setOpen(false);
      requestAnimationFrame(() => bandRef.current?.focus());
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "unknown";
      const reason = REASONS[code] ? t(REASONS[code]!) : t("objectives.band.reason.other", { code });
      setError(t(chosen.talk ? "objectives.band.failed" : "objectives.band.failedAction", { reason }));
    } finally {
      setPending(null);
    }
  };
  const press = () => {
    if (!primary) return;
    const main = intents[primary];
    if (main.talk || alts.length > 0) { setOpen(true); pick(primary, "field"); return; }
    void run(primary);
  };
  const onRadioKey = (event: ReactKeyboardEvent<HTMLButtonElement>, key: IntentKey) => {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = choices[(choices.indexOf(key) + step + choices.length) % choices.length]!;
    pick(next, "radio");
  };
  const onCompKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Esc 는 칸만 접는다 — 상세를 닫는 창 처리기로 올라가지 않게 막는다. 두 번째 Esc 가 상세를 닫는다.
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); fold(true); }
  };
  /** 보내는 동안의 부제 — 중단은 「중단하는 중…」, 나머지는 「보내는 중…」. */
  const pendingText = (key: IntentKey) => t(key === "stop" ? "objectives.band.stopping" : "objectives.band.sending");
  const word = (entry: Intent) => <span className="objectives-start-word">{entry.tone ? entry.glyph : null}{entry.word}</span>;
  const errorLine = error ? <div className="objectives-band-error" role="alert">{error}</div> : null;
  // 잠긴 개시 — 누를 수 없는 한 줄. 편집 뒤면 낱말은 「스티어링」이다. 결정은 위의 기준 줄에서 한다.
  const lockedLine = gated ? (
    <div className="objectives-start is-locked" role="note">
      <span className="objectives-start-word"><LockGlyph />{t(item.commander.started && (item.edited?.kinds.length ?? 0) > 0 ? "objectives.steer" : "objectives.coordinator.start")}</span>
      <span className="objectives-start-sub">{t("objectives.band.gated", { count: proposals })}</span>
      <span className="objectives-start-arrow" aria-hidden="true">→</span>
    </div>
  ) : null;

  if (!current || !intent) {
    // 보내는 동안은 진행 중인 그 행동을 보이고(다른 선택은 감춘다), 잠근다. 응답이 오면 사다리로 돌아간다.
    // 이동 칸은 보내기와 무관하므로 잠그지 않는다 — 보내는 중에도 ↗ 는 누를 수 있다.
    const shown = pending ?? primary!;
    const main = intents[shown];
    const others = pending ? [] : alts;
    const opens = !pending && (main.talk || others.length > 0);
    const hasDraft = !pending && main.talk && !!draft.trim();
    // 결정 대기(decide·decideMember)는 띠 자체가 이동이다 — 분할 칸 없이 끝의 → 자리에 이동 글리프가 선다.
    const decide = shown === "decide" || shown === "decideMember";
    const toneCls = main.tone ? ` is-${main.tone === "stop" ? "stop" : shown === "complete" ? "review" : "awaiting"}` : "";
    const goLabel = t("objectives.item.goToOperation");
    const bandCls = `objectives-band${others.length ? " has-alt" : ""}${main.tone === "stop" ? " is-stop" : ""}`;
    const mainButton = (
      <button
        ref={bandRef}
        type="button"
        className={`objectives-start${gated ? " is-secondary" : ""}${toneCls}${shown === "steer" || shown === "steerIdle" ? " is-steer" : ""}`}
        disabled={sending || unavailable(shown)}
        aria-busy={sending || undefined}
        title={unavailable(shown) ? t("objectives.coordinator.unavailable") : opens ? t("objectives.band.opens") : undefined}
        aria-expanded={opens ? false : undefined}
        aria-label={decide ? `${main.word} — ${goLabel}` : undefined}
        onClick={press}
      >
        {word(main)}
        <span className="objectives-start-sub">
          {hasDraft ? <b className="objectives-band-draft">{t("objectives.band.draft")}</b> : null}
          {pending ? pendingText(pending) : main.desc}
          {others.length ? <span className="objectives-band-also"> · {t("objectives.band.also", { words: others.map((key) => `「${intents[key].word}」`).join("") })}</span> : null}
        </span>
        {decide ? <span className="objectives-start-arrow" aria-hidden="true"><GoGlyph /></span> : null}
      </button>
    );
    // A 분할 칸 — 주행동과 이동이 띠 하나에 나란히 선다. 끝의 → 칸은 이동 칸으로 바뀐다.
    if (!decide) {
      return (
        <div className={`objectives-group objectives-start-group${gated ? " is-gated" : ""}`}>
          {lockedLine}
          <div className={bandCls}>
            <div className={`objectives-split${toneCls}`}>
              {mainButton}
              <button type="button" className="objectives-split-goto" aria-label={goLabel} title={goLabel} onClick={() => props.onFocusOperation(item.id)}><GoGlyph /></button>
            </div>
          </div>
          {errorLine}
        </div>
      );
    }
    return (
      <div className={`objectives-group objectives-start-group${gated ? " is-gated" : ""}`}>
        {lockedLine}
        <div className={bandCls}>
          {mainButton}
        </div>
        {errorLine}
      </div>
    );
  }

  const many = choices.length > 1;
  return (
    <div className={`objectives-group objectives-start-group${gated ? " is-gated" : ""}`}>
      {lockedLine}
      <div ref={compRef} className={`objectives-comp${current.tone === "stop" ? " is-stop" : ""}`} role="group" aria-label={t("objectives.band.send")} onKeyDown={onCompKey}>
        <div className="objectives-comp-top">
          <span>{t(many ? "objectives.band.choose" : "objectives.band.send")}</span>
          <span className="objectives-comp-tools">
            <button type="button" className="objectives-glyph objectives-comp-goto" aria-label={t("objectives.item.goToOperation")} title={t("objectives.item.goToOperation")} onClick={() => props.onFocusOperation(item.id)}><GoGlyph /></button>
            <button type="button" className="objectives-glyph objectives-comp-fold" aria-label={t("objectives.band.fold")} title={t("objectives.band.fold")} onClick={() => fold(true)}><CloseGlyph /></button>
          </span>
        </div>
        {many ? (
          <div className="objectives-intents" role="radiogroup" aria-label={t("objectives.band.intents")}>
            {choices.map((key) => {
              const entry = intents[key];
              const selected = key === intent;
              return (
                <button key={key} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} data-intent={key} disabled={sending} className={`objectives-intent${entry.tone === "stop" ? " is-stop" : ""}`} onClick={() => pick(key, "field")} onKeyDown={(event) => onRadioKey(event, key)}>
                  <span className="objectives-intent-datum" aria-hidden="true" />
                  <span className="objectives-intent-glyph" aria-hidden="true">{entry.glyph}</span>
                  <span className="objectives-intent-word">{entry.word}</span>
                  <span className="objectives-intent-desc">{entry.desc}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {current.talk ? (
          <>
            {(intent === "steer" || intent === "steerIdle") && kinds.length ? (
              <div className="objectives-comp-edits"><span>{t("objectives.band.edits")}</span>{kinds.map((kind) => <span key={kind} className="objectives-comp-chip">{kind}</span>)}</div>
            ) : null}
            <div className="objectives-comp-field">
              <textarea
                ref={fieldRef}
                rows={2}
                maxLength={MAX_CONTEXT}
                value={draft}
                disabled={sending}
                placeholder={current.placeholder}
                aria-label={t("objectives.band.fieldAria", { word: current.word })}
                onChange={(event) => { setDraft(event.target.value); setError(null); }}
                onKeyDown={(event) => { if (sendKey(event)) { event.preventDefault(); void run(intent); } }}
              />
              {draft.length >= COUNT_FROM ? <span className="objectives-comp-count" aria-live="polite">{MAX_CONTEXT - draft.length}</span> : null}
            </div>
          </>
        ) : null}
        {errorLine}
        <button
          type="button"
          className={`objectives-start objectives-comp-send${current.tone ? ` is-${current.tone === "aurora" ? "review" : "stop"}` : ""}`}
          disabled={sending || unavailable(intent)}
          title={unavailable(intent) ? t("objectives.coordinator.unavailable") : undefined}
          onClick={() => void run(intent)}
        >
          {word(current)}
          <span className="objectives-start-sub">{pending ? pendingText(pending) : current.talk ? t("objectives.band.keys") : current.desc}</span>
          <span className="objectives-start-arrow" aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  );
}
