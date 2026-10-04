import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { ConsoleOperationSummary } from "@fleet-console/sdk/plugin";
import type { PaneContext } from "@fleet-console/sdk/pane";
import type { RailEntryAttentionItem } from "@fleet-console/sdk/rail";

import type { Decision, DecisionQuestion, Objective } from "../server/types.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";
import { focusOperation, hasDecisionRequest, post, readAllTheaters, readTheater, revealObjective, subscribeObjective, takeReveal, useObjectiveTheater, useOperationSummaries, useReveal } from "./objectives-state.js";
import "./mobile.css";

/**
 * 모바일 목적지 「목표」 — 목록(결정 필요·진행 중·끝남)과 상세(브리핑·달성 기준·결정 요청·세션·임무).
 * 호스트가 페인 컨텍스트에 `mobileBar`를 실을 때만 선다. 상단 막대는 호스트가 그리고 여기서는 제목·깊이·뒤로만 선언한다.
 * 데스크톱 보드와 같은 스토어·같은 API를 읽고 쓴다 — 결정 답은 보드의 보내기와 같은 `/decision/answer`다.
 */

type T = Translate<ObjectiveMessageKey>;
type Glyph = "fresh" | "running" | "background" | "awaiting" | "idle" | "ended" | "review" | "done";

export const OBJECTIVE_MOBILE_DETAIL_PANE = "objectives-mobile-detail";

const URGENCY: Record<string, number> = { awaiting: 0, running: 1, background: 2, idle: 3, ended: 4 };
const activityGlyph = (activity: string | undefined): Glyph =>
  activity === "running" || activity === "background" || activity === "awaiting" || activity === "idle" ? activity : activity === undefined ? "fresh" : "ended";

const StatusMark = ({ state }: { readonly state: Glyph }) => <span className={`objectives-m-sg is-${state}`} aria-hidden="true" />;
const Chevron = ({ open }: { readonly open: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={open ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} /></svg>
);

const operationIndex = (operations: readonly ConsoleOperationSummary[]) => new Map(operations.map((operation) => [operation.id, operation]));
type OperationIndex = ReturnType<typeof operationIndex>;

interface SessionRow { readonly id: string; readonly role: string; readonly title: string; readonly glyph: Glyph }

/** 목표의 세션 — 지휘관이 먼저, 다음은 세션을 가진 구성원 명단 순서. 목록의 「구성원 N」도 이 수를 쓴다. */
function sessionsOf(objective: Objective, operations: OperationIndex, t: T): readonly SessionRow[] {
  const rows: SessionRow[] = [];
  const commander = operations.get(objective.id);
  if (commander || objective.commander.started) {
    rows.push({ id: objective.id, role: t("objectives.commander.title"), title: commander?.title ?? objective.title, glyph: activityGlyph(commander ? commander.ownActivity ?? commander.activity : undefined) });
  }
  for (const member of objective.members) {
    if (member.sessionName === null) continue;
    const operation = operations.get(member.id);
    rows.push({ id: member.id, role: member.role, title: operation?.title ?? member.sessionName, glyph: activityGlyph(operation?.activity) });
  }
  return rows;
}

/** 목록 줄의 글리프 — 끝남은 체크, 결정 요청은 검토, 나머지는 지휘관과 담당 가운데 가장 급한 활동. */
function objectiveGlyph(objective: Objective, operations: OperationIndex): Glyph {
  if (objective.done) return "done";
  if (hasDecisionRequest(objective) || objective.awaitingReview) return "review";
  const ids = [objective.id, ...objective.missions.flatMap((mission) => (mission.operationId ? [mission.operationId] : []))];
  const top = ids.map((id) => operations.get(id)?.activity).filter((activity): activity is NonNullable<typeof activity> => activity !== undefined)
    .reduce<string | null>((best, activity) => (best === null || (URGENCY[activity] ?? 9) < (URGENCY[best] ?? 9) ? activity : best), null);
  return top === null ? (objective.commander.started ? "idle" : "fresh") : activityGlyph(top);
}

const criteriaMet = (objective: Objective) => objective.criteria.filter((criterion) => criterion.met !== undefined).length;
const questionCount = (objective: Objective) => objective.decisionRequest?.questions.length ?? 0;

/** 모든 Theater 에서 목표 하나 — 「확인 필요」에서 다른 Theater 의 목표로 와도 찾는다. 같은 상태면 같은 참조. */
function findObjective(objectiveId: string): Objective | null {
  for (const state of readAllTheaters()) {
    const found = state.objectives.find((objective) => objective.id === objectiveId);
    if (found) return found;
  }
  return null;
}
const useObjective = (objectiveId: string) => useSyncExternalStore(subscribeObjective, () => findObjective(objectiveId), () => findObjective(objectiveId));

// ── 「확인 필요」 행 ──

const NO_ITEMS: readonly RailEntryAttentionItem[] = [];
const attentionMemo = new Map<string, { readonly source: readonly Objective[]; readonly locale: ConsoleLocale; readonly items: readonly RailEntryAttentionItem[] }>();

/** 결정 요청마다 한 행. 스냅샷이므로 같은 목록 상태·같은 언어면 같은 배열을 돌려준다. */
export function decisionAttentionItems(theaterId: string | null, locale: ConsoleLocale): readonly RailEntryAttentionItem[] {
  const source = readTheater(theaterId).objectives;
  const key = theaterId ?? "";
  const hit = attentionMemo.get(key);
  if (hit && hit.source === source && hit.locale === locale) return hit.items;
  const t = getT(locale);
  const pending = source.filter((objective) => hasDecisionRequest(objective) && !objective.removed);
  const items = pending.length === 0 ? NO_ITEMS : pending.map((objective) => ({
    id: objective.id,
    title: objective.title,
    reason: t("objectives.mobile.attention", { count: questionCount(objective) }),
    open: () => revealObjective({ objectiveId: objective.id }),
  }));
  attentionMemo.set(key, { source, locale, items });
  return items;
}

// ── 목록 ──

export function MobileObjectiveList({ ctx }: { readonly ctx: PaneContext }) {
  const t = getT(ctx.language);
  const state = useObjectiveTheater(ctx.theaterId);
  const operations = operationIndex(useOperationSummaries());
  const reveal = useReveal();
  const [doneOpen, setDoneOpen] = useState(false);
  const { mobileBar, panes, visible } = ctx;
  const title = t("objectives.panel.title");

  // 상세에서 돌아오면 막대를 다시 뿌리로 — 마지막 선언이 이기므로 보일 때마다 선언한다.
  useEffect(() => { if (visible) mobileBar?.set({ title, depth: 0 }); }, [mobileBar, visible, title]);
  // 「확인 필요」 행·팔레트가 남긴 reveal 을 집어 상세를 연다.
  useEffect(() => {
    if (!reveal) return;
    const target = takeReveal();
    if (target) panes.open({ paneId: OBJECTIVE_MOBILE_DETAIL_PANE, params: { objectiveId: target.objectiveId } });
  }, [reveal, panes]);

  const shown = state.objectives.filter((objective) => !objective.removed);
  const need = shown.filter((objective) => hasDecisionRequest(objective));
  const running = shown.filter((objective) => !objective.done && !hasDecisionRequest(objective));
  const done = shown.filter((objective) => !!objective.done);
  const open = (objective: Objective) => panes.open({ paneId: OBJECTIVE_MOBILE_DETAIL_PANE, params: { objectiveId: objective.id } });

  const row = (objective: Objective) => {
    const requests = questionCount(objective);
    const pending = hasDecisionRequest(objective);
    const members = sessionsOf(objective, operations, t).length;
    const total = objective.criteria.length;
    return (
      <button key={objective.id} type="button" className="objectives-m-row is-two" onClick={() => open(objective)}>
        <StatusMark state={objectiveGlyph(objective, operations)} />
        <span className="objectives-m-tx">
          {objective.title}
          <small className={pending ? "is-awaiting" : undefined}>
            {pending ? t("objectives.mobile.row.decision", { count: requests }) : ""}
            {total > 0 ? t("objectives.mobile.row.summary", { members, met: criteriaMet(objective), total }) : t("objectives.mobile.row.members", { members })}
          </small>
        </span>
      </button>
    );
  };

  if (!state.loaded) return <div className="objectives-m" aria-busy="true" />;
  return (
    <div className="objectives-m">
      <div className="objectives-m-pad">
        {shown.length === 0 ? <p className="objectives-m-note">{t("objectives.mobile.empty")}</p> : null}
        {need.length > 0 ? <><h2 className="objectives-m-glab">{t("objectives.mobile.zone.need")}</h2><div className="objectives-m-grp">{need.map(row)}</div></> : null}
        {running.length > 0 ? <><h2 className="objectives-m-glab">{t("objectives.mobile.zone.running")}</h2><div className="objectives-m-grp">{running.map(row)}</div></> : null}
        {done.length > 0 ? (
          <>
            <button type="button" className="objectives-m-glab is-fold" aria-expanded={doneOpen} onClick={() => setDoneOpen((value) => !value)}>
              {t("objectives.mobile.zone.done", { count: done.length })}<Chevron open={doneOpen} />
            </button>
            {doneOpen ? <div className="objectives-m-grp">{done.map(row)}</div> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── 상세 ──

export function MobileObjectiveDetail({ ctx }: { readonly ctx: PaneContext }) {
  const t = getT(ctx.language);
  const objectiveId = ctx.params.objectiveId ?? "";
  const objective = useObjective(objectiveId);
  const operations = operationIndex(useOperationSummaries());
  const { mobileBar, panes, visible } = ctx;
  const title = objective?.title ?? "";

  useEffect(() => {
    if (visible) mobileBar?.set({ title, depth: 1, onBack: () => panes.close() });
  }, [mobileBar, visible, title, panes]);

  if (!objective) return <div className="objectives-m" />;
  const sessions = sessionsOf(objective, operations, t);
  return (
    <div className="objectives-m">
      <div className="objectives-m-pad">
        <BriefCard objective={objective} t={t} />
        <DecisionSection objective={objective} t={t} language={ctx.language ?? "en"} api={ctx.api} />
        {sessions.length > 0 ? (
          <>
            <h2 className="objectives-m-glab">{t("objectives.mobile.sessions")}</h2>
            <div className="objectives-m-grp">
              {sessions.map((session) => (
                <button key={session.id} type="button" className="objectives-m-row" onClick={() => focusOperation(session.id)}>
                  <StatusMark state={session.glyph} />
                  <span className="objectives-m-tx">{session.role}<small>{session.title}</small></span>
                  <span className="objectives-m-ri"><Chevron open={false} /></span>
                </button>
              ))}
            </div>
          </>
        ) : null}
        {objective.missions.length > 0 ? (
          <>
            <h2 className="objectives-m-glab">{t("objectives.missions.title")}</h2>
            <div className="objectives-m-grp">
              {objective.missions.map((mission) => {
                const operationId = mission.operationId ?? mission.member;
                const glyph: Glyph = mission.done ? "done" : operationId ? activityGlyph(operations.get(operationId)?.activity) : "fresh";
                return (
                  <div key={mission.id} className="objectives-m-row is-mission">
                    <StatusMark state={glyph} />
                    <span className="objectives-m-tx">{mission.text}</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** 브리핑(3줄 접힘)과 달성 기준 막대. 접힌 글이 넘칠 때만 「더 보기」가 선다. */
function BriefCard({ objective, t }: { readonly objective: Objective; readonly t: T }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const brief = objective.note.trim();
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || open) return;
    setOverflows(element.scrollHeight > element.clientHeight + 1);
  }, [brief, open]);
  const total = objective.criteria.length;
  const met = criteriaMet(objective);
  if (!brief && total === 0) return null;
  return (
    <section className="objectives-m-card" aria-label={t("objectives.objective.memo")}>
      {brief ? (
        <>
          <h3 className="objectives-m-card-label">{t("objectives.objective.memo")}</h3>
          <p ref={textRef} className={`objectives-m-brief${open ? "" : " is-clamped"}`}><LinkText text={brief} /></p>
          {overflows || open ? <button type="button" className="objectives-m-more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{t(open ? "objectives.mobile.brief.less" : "objectives.mobile.brief.more")}</button> : null}
        </>
      ) : null}
      {total > 0 ? (
        <>
          <p className="objectives-m-criteria">{t("objectives.mobile.criteria", { met, total })}</p>
          <div className="objectives-m-meter" role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={met} aria-label={t("objectives.criteria.title")}><i style={{ width: `${(met / total) * 100}%` }} /></div>
        </>
      ) : null}
    </section>
  );
}

// ── 결정 요청 ──

interface Draft { readonly picked: readonly string[]; readonly text: string; readonly own: boolean }
const EMPTY_DRAFT: Draft = { picked: [], text: "", own: false };
/** 답이 된다 — 고른 것이 있거나, 선택지 없는 질문에 글을 썼거나, 「내 의견」을 고르고 글을 썼다. */
const answered = (question: DecisionQuestion, draft: Draft) =>
  draft.picked.length > 0 || ((question.options.length === 0 || draft.own) && draft.text.trim().length > 0);

/** 초안 — 다른 화면을 보고 와도 남는다(목표별, 이 탭 메모리). 요청이 바뀌면 버린다. */
const drafts = new Map<string, { readonly requestId: string; readonly drafts: Readonly<Record<string, Draft>> }>();
const storedDrafts = (objectiveId: string, requestId: string | undefined) => {
  const stored = drafts.get(objectiveId);
  if (stored && stored.requestId === requestId) return stored.drafts;
  drafts.delete(objectiveId);
  return {};
};
/** 이 탭에서 방금 보낸 요청 — 요청이 걷힌 뒤 「답을 보냈습니다」 카드가 그 답을 보인다. */
const sentRequests = new Map<string, string>();

const answerText = (decision: Decision): string => {
  const picked = decision.question.options.filter((option) => decision.answer.selectedOptionIds.includes(option.id)).map((option) => option.label);
  return [picked.join(" · "), decision.answer.text].filter((part) => part.trim().length > 0).join(" · ");
};

function DecisionSection({ objective, t, language, api }: { readonly objective: Objective; readonly t: T; readonly language: ConsoleLocale; readonly api: PaneContext["api"] }) {
  const request = objective.done ? null : objective.decisionRequest;
  const [draftMap, setDraftMap] = useState(() => storedDrafts(objective.id, request?.id));
  const [sending, setSending] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [, setSentTick] = useState(0);
  useEffect(() => { setDraftMap(storedDrafts(objective.id, request?.id)); setFault(null); }, [objective.id, request?.id]);

  if (!request) {
    const sentId = sentRequests.get(objective.id);
    const sent = sentId ? objective.decisions.filter((decision) => decision.requestId === sentId) : [];
    if (sent.length === 0) return null;
    return (
      <>
        <h2 className="objectives-m-glab">{t("objectives.decision.request")}</h2>
        <section className="objectives-m-ucard">
          <div className="objectives-m-ucard-hd"><StatusMark state="done" />{t("objectives.mobile.decision.sent")}</div>
          {sent.map((decision) => (
            <p key={decision.id} className="objectives-m-ucard-p"><LinkText text={decision.question.text} /><br /><span className="objectives-m-answer">→ {answerText(decision)}</span></p>
          ))}
        </section>
      </>
    );
  }

  const total = request.questions.length;
  const many = total > 1;
  const draftOf = (question: DecisionQuestion) => draftMap[question.id] ?? EMPTY_DRAFT;
  const doneCount = request.questions.filter((question) => answered(question, draftOf(question))).length;
  const edit = (question: DecisionQuestion, next: Draft) => {
    const nextMap = { ...draftMap, [question.id]: next };
    drafts.set(objective.id, { requestId: request.id, drafts: nextMap });
    setDraftMap(nextMap);
  };
  const pick = (question: DecisionQuestion, optionId: string) => {
    const draft = draftOf(question);
    const on = draft.picked.includes(optionId);
    const picked = question.multiSelect ? (on ? draft.picked.filter((id) => id !== optionId) : [...draft.picked, optionId]) : [optionId];
    edit(question, { ...draft, picked, own: false });
  };
  const pickOwn = (question: DecisionQuestion) => edit(question, { ...draftOf(question), picked: [], own: true });
  const unconfirmed = !sending && objective.decisionDelivery?.requestId === request.id;
  const submit = async () => {
    if (sending || doneCount !== total) return;
    setSending(true);
    setFault(null);
    // 「내 의견」이 아닌 선택지 답의 글은 보내지 않는다 — 모바일 화면에는 덧붙이는 칸이 없다.
    const answers = request.questions.map((question) => {
      const draft = draftOf(question);
      const text = question.options.length === 0 || draft.own ? draft.text : "";
      return { questionId: question.id, selectedOptionIds: draft.own ? [] : draft.picked, text };
    });
    try {
      await post(api, "/decision/answer", { objectiveId: objective.id, requestId: request.id, answers, language });
      drafts.delete(objective.id);
      sentRequests.set(objective.id, request.id);
      setSentTick((tick) => tick + 1);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setFault(code === "decision_request_changed" ? t("objectives.decision.changed") : code === "decision_delivering" ? t("objectives.decision.delivering") : t("objectives.decision.failed"));
    } finally { setSending(false); }
  };

  return (
    <>
      <h2 className="objectives-m-glab">{t("objectives.decision.request")}</h2>
      {request.questions.map((question, index) => {
        const draft = draftOf(question);
        const last = index === total - 1;
        const hasOptions = question.options.length > 0;
        return (
          <section key={question.id} className="objectives-m-ucard" aria-label={t("objectives.decision.optionsAria", { n: index + 1 })}>
            <div className="objectives-m-ucard-hd">
              <StatusMark state="review" />{t("objectives.mobile.decision.asks")}
              {many ? <span className="objectives-m-ucard-tm">{t("objectives.mobile.decision.n", { n: index + 1, total })}</span> : null}
            </div>
            <p className="objectives-m-ucard-p is-question"><LinkText text={question.text} /></p>
            {hasOptions ? (
              <div role={question.multiSelect ? "group" : "radiogroup"}>
                {question.options.map((option) => {
                  const on = !draft.own && draft.picked.includes(option.id);
                  return (
                    <button key={option.id} type="button" role={question.multiSelect ? "checkbox" : "radio"} aria-checked={on} disabled={sending} className="objectives-m-opt" onClick={() => pick(question, option.id)}>
                      <span className={`objectives-m-ind${question.multiSelect ? " is-check" : ""}${on ? " is-on" : ""}`} aria-hidden="true" />
                      <span className="objectives-m-opt-tx">{option.label}{option.description ? <small>{option.description}</small> : null}</span>
                    </button>
                  );
                })}
                <button type="button" role={question.multiSelect ? "checkbox" : "radio"} aria-checked={draft.own} disabled={sending} className="objectives-m-opt" onClick={() => pickOwn(question)}>
                  <span className={`objectives-m-ind${question.multiSelect ? " is-check" : ""}${draft.own ? " is-on" : ""}`} aria-hidden="true" />
                  <span className="objectives-m-opt-tx">{t("objectives.decision.own")}</span>
                </button>
                {question.multiSelect ? <p className="objectives-m-hint">{t("objectives.decision.multiHint")}</p> : null}
              </div>
            ) : null}
            {!hasOptions || draft.own ? (
              <textarea
                className="objectives-m-field"
                maxLength={2000}
                disabled={sending}
                value={draft.text}
                aria-label={t("objectives.decision.writeAria", { n: index + 1 })}
                placeholder={t(hasOptions ? "objectives.decision.writeOwn" : "objectives.decision.write")}
                onChange={(event) => edit(question, { ...draft, text: event.target.value })}
              />
            ) : null}
            {last ? (
              <div className="objectives-m-ucard-ft">
                {many ? <span className="objectives-m-progress">{t("objectives.decision.progress", { done: doneCount, total })}</span> : null}
                <span className="objectives-m-sp" />
                <button type="button" className="objectives-m-b2" disabled={sending || doneCount !== total} onClick={() => void submit()}>
                  {t(sending ? "objectives.decision.sending" : "objectives.mobile.decision.send")}
                </button>
              </div>
            ) : null}
            {last && (fault || unconfirmed) ? <p className="objectives-m-fault" role="status">{fault ?? t("objectives.decision.unknown")}</p> : null}
          </section>
        );
      })}
    </>
  );
}
