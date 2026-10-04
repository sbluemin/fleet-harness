import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { ConsoleOperationSummary } from "@fleet-console/sdk/plugin";
import type { MobileBarMenuItem, PaneContext } from "@fleet-console/sdk/pane";
import type { RailEntryAttentionItem } from "@fleet-console/sdk/rail";

import type { Decision, DecisionQuestion, Objective } from "../server/types.js";
import { bandChoices, bandFailure } from "./action-band.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";
import { focusOperation, hasDecisionRequest, post, readAllTheaters, readTheater, revealObjective, subscribeObjective, takeReveal, useObjectiveTheater, useOperationSummaries, useReveal } from "./objectives-state.js";
import "./mobile.css";

/**
 * 모바일 목적지 「목표」 — 목록(결정 필요·진행 중·끝남)과 상세(브리핑·달성 기준·결정 요청·세션·임무).
 * 호스트가 페인 컨텍스트에 `mobileBar`를 실을 때만 선다. 상단 막대는 호스트가 그리고 여기서는 제목·깊이·뒤로·⋮ 항목만 선언한다.
 * 데스크톱 보드와 같은 스토어·같은 API를 쓴다 — 결정 답·메시지·완료·인계·중단 모두 보드와 같은 경로이고, ⋮ 의 노출 판정도
 * 보드 하단 띠의 판정(`bandChoices`)을 그대로 쓴다.
 */

type T = Translate<ObjectiveMessageKey>;
type Glyph = "fresh" | "running" | "background" | "awaiting" | "idle" | "ended" | "review" | "done";

export const OBJECTIVE_MOBILE_DETAIL_PANE = "objectives-mobile-detail";

const TOAST_MS = 6_000;
const SHEET_CLOSE_MS = 220;
const SHEET_DISMISS_PX = 110;
const SHEET_DRAG_SLOP_PX = 6;
const WORKING = new Set(["running", "background"]);
const URGENCY: Record<string, number> = { awaiting: 0, running: 1, background: 2, idle: 3, ended: 4 };
const activityGlyph = (activity: string | undefined): Glyph =>
  activity === "running" || activity === "background" || activity === "awaiting" || activity === "idle" ? activity : activity === undefined ? "fresh" : "ended";

const StatusMark = ({ state }: { readonly state: Glyph }) => <span className={`objectives-m-sg is-${state}`} aria-hidden="true" />;
/** 시안 아이콘 문법 — 24 viewBox, 선 1.7, 둥근 끝. */
const Icon = ({ children, size = 20 }: { readonly children: ReactNode; readonly size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const Chevron = ({ open, size }: { readonly open: boolean; readonly size?: number }) => <Icon size={size ?? 22}><path d={open ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} /></Icon>;
const MessageIcon = () => <Icon><path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /><path d="M12 7.5v6M9 10.5h6" /></Icon>;
const CheckIcon = ({ size }: { readonly size?: number }) => <Icon size={size ?? 20}><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>;
const SendIcon = () => <Icon><path d="M12 19V5M6 11l6-6 6 6" /></Icon>;
const StopIcon = () => <Icon><rect x="7.5" y="7.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" /></Icon>;
const CloseIcon = () => <Icon><path d="M6 6l12 12M18 6L6 18" /></Icon>;

const operationIndex = (operations: readonly ConsoleOperationSummary[]) => new Map(operations.map((operation) => [operation.id, operation]));
type OperationIndex = ReturnType<typeof operationIndex>;
const activityOf = (operations: OperationIndex, id: string): string => operations.get(id)?.activity ?? "closed";
/** 지휘관 자신의 활동 — 코어가 구성원 활동을 끌어올리기 전 값. 보드와 같은 셈이다. */
const ownActivityOf = (operations: OperationIndex, id: string): string => { const operation = operations.get(id); return operation ? operation.ownActivity ?? operation.activity : "closed"; };

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

/** 목록 줄의 글리프 — 끝남은 체크, 결정 요청·검토 대기는 검토, 나머지는 지휘관과 담당 가운데 가장 급한 활동. */
function objectiveGlyph(objective: Objective, operations: OperationIndex): Glyph {
  if (objective.done) return "done";
  if (hasDecisionRequest(objective) || objective.awaitingReview) return "review";
  const ids = [objective.id, ...objective.missions.flatMap((mission) => (mission.operationId ? [mission.operationId] : []))];
  const top = ids.map((id) => operations.get(id)?.activity).filter((activity): activity is NonNullable<typeof activity> => activity !== undefined)
    .reduce<string | null>((best, activity) => (best === null || (URGENCY[activity] ?? 9) < (URGENCY[best] ?? 9) ? activity : best), null);
  return top === null ? (objective.commander.started ? "idle" : "fresh") : activityGlyph(top);
}

const criteriaMet = (objective: Objective) => objective.criteria.filter((criterion) => criterion.met !== undefined).length;
/** 결정은 요청 단위로 센다 — 목표마다 요청은 하나이고, 질문이 여럿이어도 「결정 요청 1건」이다. */
const requestCount = (objective: Objective) => (hasDecisionRequest(objective) ? 1 : 0);
/**
 * 목록에 서는 목표 — 기록이 없는 항목(`recorded === false`, 따로 만든 에이전트 Operation 이 「목표 밖」에 선 것)은 목표가 아니다.
 * 데스크톱 보드는 그것을 「목표 밖」으로 가르지만, 모바일 목표 화면에는 그 구역이 없다.
 */
const isListedObjective = (objective: Objective) => !objective.removed && objective.recorded !== false;

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
  const pending = source.filter((objective) => hasDecisionRequest(objective) && isListedObjective(objective));
  const items = pending.length === 0 ? NO_ITEMS : pending.map((objective) => ({
    id: objective.id,
    title: objective.title,
    reason: t("objectives.mobile.attention", { count: requestCount(objective) }),
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

  const shown = state.objectives.filter(isListedObjective);
  const need = shown.filter((objective) => hasDecisionRequest(objective));
  const running = shown.filter((objective) => !objective.done && !hasDecisionRequest(objective));
  const done = shown.filter((objective) => !!objective.done);
  const open = (objective: Objective) => panes.open({ paneId: OBJECTIVE_MOBILE_DETAIL_PANE, params: { objectiveId: objective.id } });

  const row = (objective: Objective) => {
    const pending = hasDecisionRequest(objective);
    // 구성원 수는 명단(roster) 그대로다 — 지휘관은 구성원이 아니다(보드·데이터와 같은 셈).
    const members = objective.members.length;
    const total = objective.criteria.length;
    return (
      <button key={objective.id} type="button" className="objectives-m-row is-two" onClick={() => open(objective)}>
        <StatusMark state={objectiveGlyph(objective, operations)} />
        <span className="objectives-m-tx">
          {objective.title}
          <small className={pending ? "is-awaiting" : undefined}>
            {pending ? t("objectives.mobile.row.decision", { count: requestCount(objective) }) : ""}
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
        {shown.length > 0 ? (
          <>
            <button type="button" className="objectives-m-glab is-fold" aria-expanded={doneOpen} onClick={() => setDoneOpen((value) => !value)}>
              {t("objectives.mobile.zone.done", { count: done.length })}<Chevron open={doneOpen} size={16} />
            </button>
            {doneOpen && done.length > 0 ? <div className="objectives-m-grp">{done.map(row)}</div> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── 상세 ──

interface Recipient { readonly id: string; readonly role: string; readonly state: string }
interface ObjectiveActions {
  readonly recipients: readonly Recipient[];
  readonly message: boolean;
  readonly complete: boolean;
  readonly handOff: boolean;
  readonly stop: boolean;
}

/** ⋮ 의 사람 동작 — 데스크톱 하단 띠와 같은 판정에서, 폰에서 의미 있는 넷(메시지·완료·검토로 넘기기·중단)만 고른다. */
function objectiveActions(objective: Objective, operations: OperationIndex, t: T): ObjectiveActions {
  const done = !!objective.done;
  const working = !done && (WORKING.has(ownActivityOf(operations, objective.id)) || objective.members.some((member) => member.sessionName !== null && WORKING.has(activityOf(operations, member.id))));
  const commanderAwaiting = !done && ownActivityOf(operations, objective.id) === "awaiting";
  const awaitingMember = done ? undefined : objective.members.find((member) => member.sessionName !== null && activityOf(operations, member.id) === "awaiting");
  const memberMission = awaitingMember ? objective.missions.findIndex((mission) => !mission.done && mission.member === awaitingMember.id) : -1;
  const memberAwaiting = awaitingMember ? { operationId: awaitingMember.id, role: awaitingMember.role, mission: memberMission >= 0 ? memberMission + 1 : null } : null;
  const recipients = [
    { id: objective.id, role: t("objectives.graph.commander"), state: ownActivityOf(operations, objective.id) },
    ...objective.members.filter((member) => member.sessionName !== null).map((member) => ({ id: member.id, role: member.role, state: activityOf(operations, member.id) })),
  ].filter((recipient) => recipient.state !== "closed");
  const choices = bandChoices({ objective, working, commanderAwaiting, memberAwaiting, commanderExists: activityOf(operations, objective.id) !== "closed", recipientCount: recipients.length });
  const has = (key: (typeof choices.alts)[number]) => choices.primary === key || choices.alts.includes(key);
  // 후속 후보가 있으면 완료는 후보 고르기를 거쳐야 한다 — 폰에서는 그 고르기가 없으므로 완료를 세우지 않는다.
  return { recipients, message: has("message"), complete: has("complete") && !choices.followupAvailable, handOff: has("handOff"), stop: has("stop") };
}

export function MobileObjectiveDetail({ ctx }: { readonly ctx: PaneContext }) {
  const t = getT(ctx.language);
  const language = ctx.language ?? "en";
  const objectiveId = ctx.params.objectiveId ?? "";
  const objective = useObjective(objectiveId);
  const operations = operationIndex(useOperationSummaries());
  const { mobileBar, panes, visible, api } = ctx;
  const title = objective?.title ?? "";
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState<{ readonly text: string; readonly at: number } | null>(null);
  const say = useCallback((text: string) => setToast({ text, at: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const actions = objective ? objectiveActions(objective, operations, t) : null;
  // 막대 선언은 내용이 바뀔 때만 다시 한다 — 매 렌더 선언하면 호스트 갱신과 맞물려 돈다. 동작은 ref 로 최신을 부른다.
  const latest = useRef({ actions, objectiveId, say, language, t });
  latest.current = { actions, objectiveId, say, language, t };
  const act = useCallback((path: string) => {
    const { objectiveId: id, say: speak, language: locale, t: translate } = latest.current;
    void post(api, path, { objectiveId: id, language: locale }).catch((error: unknown) => speak(bandFailure(translate, error, { message: false, talk: false })));
  }, [api]);
  const menuKey = actions ? `${actions.message ? 1 : 0}${actions.complete ? 1 : 0}${actions.handOff ? 1 : 0}${actions.stop ? 1 : 0}` : "";
  useEffect(() => {
    if (!visible || !mobileBar) return;
    const current = latest.current.actions;
    const items: MobileBarMenuItem[] = [];
    if (current) {
      // 「메시지」는 늘 선다 — 받을 세션이 없거나 띠가 다른 할 일을 먼저 세우는 동안은 흐리게.
      items.push({ id: "message", label: t("objectives.message"), icon: <MessageIcon />, disabled: !current.message, run: () => setSheet(true) });
      if (current.complete) items.push({ id: "complete", label: t("objectives.review.complete"), icon: <CheckIcon />, run: () => act("/objective/complete") });
      if (current.handOff) items.push({ id: "handOff", label: t("objectives.handoff.send"), icon: <SendIcon />, run: () => act("/objective/hand-off") });
      // 중단은 다시 개시할 수 있어 파괴 동작이 아니다 — 일반 색.
      if (current.stop) items.push({ id: "stop", label: t("objectives.stop"), icon: <StopIcon />, run: () => act("/commander/stop") });
    }
    mobileBar.set({ title, depth: 1, onBack: () => panes.close(), ...(items.length > 0 ? { menu: { caption: title, items } } : {}) });
  }, [mobileBar, visible, title, panes, menuKey, t, act]);

  if (!objective || !actions) return <div className="objectives-m" />;
  const sessions = sessionsOf(objective, operations, t);
  return (
    <div className="objectives-m">
      <div className="objectives-m-pad">
        <BriefCard objective={objective} t={t} />
        <DecisionSection objective={objective} t={t} language={language} api={api} say={say} />
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
      {sheet ? <MessageSheet t={t} objectiveId={objective.id} recipients={actions.recipients} api={api} language={language} say={say} onClose={() => setSheet(false)} /> : null}
      {toast ? createPortal(<div key={toast.at} className="objectives-m-toast" role="status">{toast.text}</div>, document.body) : null}
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
/** 답이 된다 — 고른 것이 있거나, 선택지 없는 질문에 글을 썼거나, 「내 의견」을 고르고 글을 썼다(빈 내 의견은 답이 아니다). */
const answered = (question: DecisionQuestion, draft: Draft) =>
  (!draft.own && draft.picked.length > 0) || ((question.options.length === 0 || draft.own) && draft.text.trim().length > 0);

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

/** 보낸 답 — 고른 것은 「 · 」로 잇고, 직접 쓴 말은 다음 줄에 그대로. */
const answerText = (decision: Decision): string => {
  const picked = decision.question.options.filter((option) => decision.answer.selectedOptionIds.includes(option.id)).map((option) => option.label);
  return [picked.join(" · "), decision.answer.text.trim()].filter((part) => part.length > 0).join("\n");
};

function DecisionSection({ objective, t, language, api, say }: { readonly objective: Objective; readonly t: T; readonly language: ConsoleLocale; readonly api: PaneContext["api"]; readonly say: (text: string) => void }) {
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
    const base = draft.own ? [] : draft.picked;
    const on = base.includes(optionId);
    const picked = question.multiSelect ? (on ? base.filter((id) => id !== optionId) : [...base, optionId]) : [optionId];
    edit(question, { ...draft, picked, own: false });
  };
  // 내 의견 — 여러 개 고르는 질문에서도 홀로 선다. 고른 것을 비운다.
  const pickOwn = (question: DecisionQuestion) => edit(question, { ...draftOf(question), picked: [], own: true });
  const unconfirmed = !sending && objective.decisionDelivery?.requestId === request.id;
  const submit = async () => {
    if (sending || doneCount !== total) return;
    setSending(true);
    setFault(null);
    // 선택지 답에는 글을 싣지 않는다 — 모바일에는 덧붙이는 칸이 없고, 내 의견이면 고른 것 없이 글만 간다(보드의 내 의견과 같은 모양).
    const answers = request.questions.map((question) => {
      const draft = draftOf(question);
      const free = question.options.length === 0 || draft.own;
      return { questionId: question.id, selectedOptionIds: free ? [] : draft.picked, text: free ? draft.text.trim() : "" };
    });
    try {
      await post(api, "/decision/answer", { objectiveId: objective.id, requestId: request.id, answers, language });
      drafts.delete(objective.id);
      sentRequests.set(objective.id, request.id);
      setSentTick((tick) => tick + 1);
      say(t("objectives.mobile.toast.decision"));
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setFault(code === "decision_request_changed" ? t("objectives.decision.changed") : code === "decision_delivering" ? t("objectives.decision.delivering") : t("objectives.decision.failed"));
    } finally { setSending(false); }
  };

  return (
    <>
      <h2 className="objectives-m-glab">{t("objectives.decision.request")}</h2>
      <div className="objectives-m-stack">
        {request.questions.map((question, index) => {
          const draft = draftOf(question);
          const last = index === total - 1;
          const hasOptions = question.options.length > 0;
          const head = !many ? t("objectives.mobile.decision.asks") : index === 0 ? t("objectives.mobile.decision.firstOf", { n: 1, total }) : t("objectives.mobile.decision.of", { n: index + 1, total });
          const indicator = `objectives-m-ind${question.multiSelect ? " is-check" : ""}`;
          return (
            <section key={question.id} className="objectives-m-ucard" aria-label={head}>
              <div className="objectives-m-ucard-hd"><StatusMark state="review" />{head}</div>
              <p className="objectives-m-ucard-p is-question"><LinkText text={question.text} /></p>
              {hasOptions && question.multiSelect ? <p className="objectives-m-hint">{t("objectives.decision.multiHint")}</p> : null}
              {hasOptions ? (
                <div role={question.multiSelect ? "group" : "radiogroup"} aria-label={t("objectives.decision.optionsAria", { n: index + 1 })}>
                  {question.options.map((option) => {
                    const on = !draft.own && draft.picked.includes(option.id);
                    return (
                      <button key={option.id} type="button" role={question.multiSelect ? "checkbox" : "radio"} aria-checked={on} disabled={sending} className="objectives-m-opt" onClick={() => pick(question, option.id)}>
                        <span className={`${indicator}${on ? " is-on" : ""}`} aria-hidden="true">{question.multiSelect && on ? <CheckIcon size={14} /> : null}</span>
                        <span className="objectives-m-opt-tx">{option.label}{option.description ? <small>{option.description}</small> : null}</span>
                      </button>
                    );
                  })}
                  <button type="button" role={question.multiSelect ? "checkbox" : "radio"} aria-checked={draft.own} disabled={sending} className="objectives-m-opt" onClick={() => pickOwn(question)}>
                    <span className={`${indicator}${draft.own ? " is-on" : ""}`} aria-hidden="true">{question.multiSelect && draft.own ? <CheckIcon size={14} /> : null}</span>
                    <span className="objectives-m-opt-tx">{t("objectives.decision.own")}</span>
                  </button>
                </div>
              ) : null}
              {!hasOptions || draft.own ? (
                <textarea
                  className={`objectives-m-field${hasOptions ? " is-unfold" : ""}`}
                  maxLength={2000}
                  disabled={sending}
                  value={draft.text}
                  aria-label={t("objectives.decision.writeAria", { n: index + 1 })}
                  placeholder={t(hasOptions ? "objectives.decision.writeOwn" : "objectives.decision.write")}
                  onChange={(event) => edit(question, { ...draft, text: event.target.value })}
                />
              ) : null}
              {last && (fault || unconfirmed) ? <p className="objectives-m-fault" role="status">{fault ?? t("objectives.decision.unknown")}</p> : null}
              {last ? (
                <div className="objectives-m-ucard-ft">
                  {many ? <span className="objectives-m-progress">{t("objectives.decision.progress", { done: doneCount, total })}</span> : null}
                  <span className="objectives-m-sp" />
                  <button type="button" className="objectives-m-b2" disabled={sending || doneCount !== total} onClick={() => void submit()}>
                    {t(sending ? "objectives.decision.sending" : "objectives.mobile.decision.send")}
                  </button>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </>
  );
}

// ── 메시지 시트 ──

const HOW_KEYS: Readonly<Record<string, ObjectiveMessageKey>> = {
  running: "objectives.band.message.how.working",
  background: "objectives.band.message.how.working",
  ended: "objectives.band.message.how.dormant",
  awaiting: "objectives.band.message.how.awaiting",
};

/**
 * 「메시지」 하단 시트 — 받는 사람 칩 줄 + 여러 줄 입력칸 + 「보내기」. 보드 띠의 메시지와 같은 `/commander/message`다.
 * 허용 요청을 기다리는 받는 이는 호스트가 거절하므로 보내기를 잠그고 그 사정을 한 줄로 보인다.
 */
function MessageSheet({ t, objectiveId, recipients, api, language, say, onClose }: {
  readonly t: T;
  readonly objectiveId: string;
  readonly recipients: readonly Recipient[];
  readonly api: PaneContext["api"];
  readonly language: ConsoleLocale;
  readonly say: (text: string) => void;
  readonly onClose: () => void;
}) {
  const [to, setTo] = useState(recipients[0]?.id ?? "");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<{ readonly y: number; readonly moved: boolean } | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const recipient = recipients.find((candidate) => candidate.id === to) ?? recipients[0] ?? null;
  const blocked = recipient?.state === "awaiting";

  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, SHEET_CLOSE_MS);
  }, [closing, onClose]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  useEffect(() => { fieldRef.current?.focus({ preventScroll: true }); }, []);

  const send = async () => {
    if (!recipient || blocked || sending || !text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await post(api, "/commander/message", { objectiveId, memberId: recipient.id === objectiveId ? null : recipient.id, text: text.trim(), language });
      say(t("objectives.message.sent", { role: recipient.role }));
      close();
    } catch (failure) {
      setError(bandFailure(t, failure, { message: true, talk: true }));
    } finally { setSending(false); }
  };

  // 손잡이에서 끌어내리기 — 6 넘게 움직이면 따라오고, 110 넘게 끌고 놓으면 닫는다.
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => { event.currentTarget.setPointerCapture(event.pointerId); dragStart.current = { y: event.clientY, moved: false }; };
  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start) return;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.abs(dy) < SHEET_DRAG_SLOP_PX) return;
    dragStart.current = { ...start, moved: true };
    setDrag(Math.max(0, dy));
  };
  const onHandleUp = () => {
    const moved = dragStart.current?.moved === true;
    dragStart.current = null;
    if (moved && drag > SHEET_DISMISS_PX) close();
    else setDrag(0);
  };

  const how = recipient ? `${t(HOW_KEYS[recipient.state] ?? "objectives.band.message.how.idle")}${recipient.id !== objectiveId && !blocked ? t("objectives.band.message.alsoCommander") : ""}` : "";
  return createPortal(
    <div className={`objectives-m-sheet-layer${closing ? " is-closing" : ""}`}>
      <div className="objectives-m-scrim" onClick={close} />
      <div className={`objectives-m-sheet${drag > 0 ? " is-dragging" : ""}`} role="dialog" aria-modal="true" aria-label={t("objectives.message")} style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}>
        <div className="objectives-m-sheet-handle" onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}><i /></div>
        <div className="objectives-m-sheet-head">
          <h2>{t("objectives.message")}</h2>
          <button type="button" className="objectives-m-sheet-x" aria-label={t("objectives.detail.close")} onClick={close}><CloseIcon /></button>
        </div>
        <div className="objectives-m-sheet-body">
          <div className="objectives-m-chips" role="radiogroup" aria-label={t("objectives.message")}>
            {recipients.map((candidate) => (
              <button key={candidate.id} type="button" role="radio" aria-checked={candidate.id === recipient?.id} className={`objectives-m-pill2${candidate.id === recipient?.id ? " is-inv" : ""}`} onClick={() => { setTo(candidate.id); setError(null); }}>{candidate.role}</button>
            ))}
          </div>
          <textarea
            ref={fieldRef}
            className="objectives-m-field"
            maxLength={8000}
            disabled={sending}
            value={text}
            aria-label={t("objectives.band.message.ph", { role: recipient?.role ?? "" })}
            placeholder={t("objectives.band.message.ph", { role: recipient?.role ?? "" })}
            onChange={(event) => { setText(event.target.value); setError(null); }}
          />
          {error ? <p className="objectives-m-fault" role="status">{error}</p> : how ? <p className="objectives-m-secnote">{how}</p> : null}
        </div>
        <div className="objectives-m-sheet-ft">
          <button type="button" className="objectives-m-pill2 is-inv" disabled={!recipient || blocked || sending || !text.trim()} onClick={() => void send()}>
            {t(sending ? "objectives.decision.sending" : "objectives.mobile.message.send")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
