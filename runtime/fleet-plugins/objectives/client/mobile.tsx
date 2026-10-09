import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { ConsoleOperationSummary } from "@fleet-console/sdk/plugin";
import type { MobileBarMenuItem, PaneContext } from "@fleet-console/sdk/pane";
import type { RailEntryAttentionItem } from "@fleet-console/sdk/rail";
import { SettingsCard, SettingsRow, SettingsToggle } from "@fleet-console/sdk/settings/browser";

import type { Decision, DecisionQuestion, Objective, ObjectiveMember } from "../server/types.js";
import { bandChoices, bandFailure } from "./action-band.js";
import { memberFailureNote } from "./clusters.js";
import { commodoreBoardOf, subscribeCommodore, useCommodoreBoard } from "./commodore-state.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { hasRoutingReason, LaunchControl, launchedWords, MEMBER_LIVE, MemberLaunchControl, memberSubagents, routingReason, useLaunchRows, type MemberLaunchChoice } from "./launch-control.js";
import { ObjectiveLinkOpenProvider } from "./link-open-context.js";
import { LinkText } from "./link-text.js";
import { ObjectiveResults } from "./results.js";
import { focusOperation, hasDecisionRequest, post, readAllTheaters, readTheater, revealObjective, subscribeObjective, takeReveal, useObjectiveTheater, useOperationSummaries, useReveal } from "./objectives-state.js";
import "./mobile.css";

/**
 * 모바일 목적지 「목표」 — 목록(결정 필요·진행 중·시작 전·끝남)과 상세(브리핑·달성 기준·결정 요청·지휘관·구성원·임무·결과물).
 * 호스트가 페인 컨텍스트에 `mobileBar`를 실을 때만 선다. 상단 막대는 호스트가 그리고 여기서는 제목·깊이·뒤로·⋮ 항목만 선언한다.
 * 데스크톱 보드와 같은 스토어·같은 API를 쓴다 — 결정 답·메시지·완료·인계·중단 모두 보드와 같은 경로이고, ⋮ 의 노출 판정도
 * 보드 하단 띠의 판정(`bandChoices`)을 그대로 쓴다. 지휘관·구성원의 모델·강도는 데스크톱 명단과 같은 어댑터(`LaunchControl`)이고,
 * 호스트의 모바일 설정 문법 안에서 공유 선택기가 좌표 시트로 선다.
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
const LockIcon = () => <Icon size={14}><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></Icon>;

const operationIndex = (operations: readonly ConsoleOperationSummary[]) => new Map(operations.map((operation) => [operation.id, operation]));
type OperationIndex = ReturnType<typeof operationIndex>;
const activityOf = (operations: OperationIndex, id: string): string => operations.get(id)?.activity ?? "closed";
/** 지휘관 자신의 활동 — 코어가 구성원 활동을 끌어올리기 전 값. 보드와 같은 셈이다. */
const ownActivityOf = (operations: OperationIndex, id: string): string => { const operation = operations.get(id); return operation ? operation.ownActivity ?? operation.activity : "closed"; };

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
const attentionMemo = new Map<string, { readonly source: readonly Objective[]; readonly locale: ConsoleLocale; readonly answering: boolean; readonly items: readonly RailEntryAttentionItem[] }>();

/** 「확인 필요」 행의 갱신 신호 — 목표 상태와 사령관 상태(답하는 중 메모)가 모두 행을 바꾼다. */
export function subscribeDecisionAttention(listener: () => void): () => void {
  const offObjective = subscribeObjective(listener);
  const offCommodore = subscribeCommodore(listener);
  return () => { offObjective(); offCommodore(); };
}

/** 결정 요청마다 한 행. 스냅샷이므로 같은 목록 상태·같은 언어면 같은 배열을 돌려준다. */
export function decisionAttentionItems(theaterId: string | null, locale: ConsoleLocale): readonly RailEntryAttentionItem[] {
  const source = readTheater(theaterId).objectives;
  const key = theaterId ?? "";
  // 자율 운영이 실제로 돌면 사령관이 답한다 — 데스크톱 사이드바 메모와 같은 판정(S-53 CM-1d). 그래도 사람의 일로 센다.
  const answering = theaterId !== null && commodoreBoardOf(theaterId).active;
  const hit = attentionMemo.get(key);
  if (hit && hit.source === source && hit.locale === locale && hit.answering === answering) return hit.items;
  const t = getT(locale);
  const pending = source.filter((objective) => hasDecisionRequest(objective) && isListedObjective(objective));
  const items = pending.length === 0 ? NO_ITEMS : pending.map((objective) => ({
    id: objective.id,
    title: objective.title,
    // 사람이 운영하는 목표의 요청으로는 사령관이 깨어나지 않는다 — 「답하는 중」은 사령관의 목표에만(서버 판정 `operator`).
    reason: answering && objective.operator !== "human" ? `${t("objectives.mobile.attention", { count: requestCount(objective) })} · ${t("objectives.commodore.note.answering")}` : t("objectives.mobile.attention", { count: requestCount(objective) }),
    open: () => revealObjective({ objectiveId: objective.id }),
  }));
  attentionMemo.set(key, { source, locale, answering, items });
  return items;
}

// ── 목록 ──

export function MobileObjectiveList({ ctx }: { readonly ctx: PaneContext }) {
  const t = getT(ctx.language);
  const state = useObjectiveTheater(ctx.theaterId);
  const commodore = useCommodoreBoard(ctx.theaterId ?? "");
  const operations = operationIndex(useOperationSummaries());
  const reveal = useReveal();
  const [doneOpen, setDoneOpen] = useState(false);
  // 「시작 전」은 펼친 채로 연다 — 접어 두면 시작 전 목표 하나를 여는 데 한 번 더 눌러야 한다.
  const [freshOpen, setFreshOpen] = useState(true);
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
  // 데스크톱 접기(`switcher.tsx` freshOf)와 같은 판정 — 개시 전이고, 지휘관 Operation 이 없고, 검토 대기가 아니다.
  const fresh = (objective: Objective) => !objective.awaitingReview && !objective.commander.started && !operations.has(objective.id);
  const live = shown.filter((objective) => !objective.done && !hasDecisionRequest(objective));
  const running = live.filter((objective) => !fresh(objective));
  const notStarted = live.filter(fresh);
  const done = shown.filter((objective) => !!objective.done);
  const open = (objective: Objective) => panes.open({ paneId: OBJECTIVE_MOBILE_DETAIL_PANE, params: { objectiveId: objective.id } });

  const row = (objective: Objective) => {
    const pending = hasDecisionRequest(objective);
    // 구성원 수는 명단(roster) 그대로다 — 지휘관은 구성원이 아니다(보드·데이터와 같은 셈).
    const members = objective.members.length;
    const total = objective.criteria.length;
    // 데스크톱 사이드바 줄 메모와 같은 판정 — 확인하지 않은 구성원 실패가 남은 동안만 선다.
    const failed = memberFailureNote(objective);
    return (
      <button key={objective.id} type="button" data-press="r2" className="objectives-m-row is-two" onClick={() => open(objective)}>
        <StatusMark state={objectiveGlyph(objective, operations)} />
        <span className="objectives-m-tx">
          {objective.title}
          <small className={pending ? "is-awaiting" : undefined}>
            {pending ? t("objectives.mobile.row.decision", { count: requestCount(objective) }) : ""}
            {pending && commodore.active && objective.operator !== "human" ? `${t("objectives.commodore.note.answering")} · ` : ""}
            {failed ? <><span className="objectives-m-failed">{t(failed)}</span>{" · "}</> : null}
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
        {notStarted.length > 0 ? (
          <>
            <button type="button" data-press="r1" className="objectives-m-glab is-fold" aria-expanded={freshOpen} onClick={() => setFreshOpen((value) => !value)}>
              {t("objectives.mobile.zone.fresh", { count: notStarted.length })}<Chevron open={freshOpen} size={16} />
            </button>
            {freshOpen ? <div className="objectives-m-grp">{notStarted.map(row)}</div> : null}
          </>
        ) : null}
        {shown.length > 0 ? (
          <>
            <button type="button" data-press="r1" className="objectives-m-glab is-fold" aria-expanded={doneOpen} onClick={() => setDoneOpen((value) => !value)}>
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
  const crew = useCrewActions(objective, operations, t, api, language, say);
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
    mobileBar.set({ title, depth: 1, onBack: () => panes.close(), ...(items.length > 0 ? { menu: { label: t("objectives.mobile.menuLabel"), caption: title, items } } : {}) });
  }, [mobileBar, visible, title, panes, menuKey, t, act]);

  if (!objective || !actions) return <div className="objectives-m" />;
  return (
    <div className="objectives-m">
      <div className="objectives-m-pad">
        <BriefCard objective={objective} t={t} />
        <ProposalsCard objective={objective} t={t} language={language} api={api} say={say} />
        <DecisionSection objective={objective} t={t} language={language} api={api} say={say} />
        <CrewSection objective={objective} operations={operations} t={t} crew={crew} />
        {/* 세션 진입을 겸하는 지휘관·구성원은 임무 위, 설정 전용 카드(서브에이전트 허용)는 임무·결과물 아래에 둔다(폰 첫 화면에 임무가 보이게). */}
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
        <ResultsSection objective={objective} t={t} language={language} openLink={ctx.openLink ?? null} />
        <SubagentsSection objective={objective} t={t} crew={crew} />
      </div>
      {sheet ? <MessageSheet t={t} objectiveId={objective.id} recipients={actions.recipients} api={api} language={language} say={say} onClose={() => setSheet(false)} /> : null}
      {toast ? createPortal(<div key={toast.at} className="objectives-m-toast" role="status">{toast.text}</div>, document.body) : null}
    </div>
  );
}

// ── 결과물 ──

/**
 * 결과물 — 데스크톱 장부(`ObjectiveResults`)를 그대로 세운다. 보고서·이미지 보기와 증거 문서의 무력화도 데스크톱과 같은
 * 구성요소·같은 경로다. 그래프가 없으므로 ↗(그래프에서 보기)는 넘기지 않고, 임무 묶음은 처음부터 모두 펼쳐 둔다(접은 것만 이 화면이 기억한다).
 * 모양은 mobile.css 의 `.objectives-m-results` 범위와 모바일 배치의 보기 규칙이 맡는다.
 */
function ResultsSection({ objective, t, language, openLink }: { readonly objective: Objective; readonly t: T; readonly language: ConsoleLocale; readonly openLink: NonNullable<PaneContext["openLink"]> | null }) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => setClosed((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
  if (objective.results.length === 0) return null;
  return (
    <>
      <h2 className="objectives-m-glab">{t("objectives.results.title")}</h2>
      <ObjectiveLinkOpenProvider value={openLink}>
        <div className="objectives-m-results">
          <ObjectiveResults objective={objective} t={t} language={language} highlightMission={null} groupOpen={(key) => !closed.has(key)} onToggleGroup={toggle} />
        </div>
      </ObjectiveLinkOpenProvider>
    </>
  );
}

// ── 지휘관·구성원 ──

const COMMANDER_LIVE = new Set(["idle", "running", "background", "awaiting"]);

/** 거절 코드 → 토스트 한 줄. 라우팅·전환 사유는 사람의 말로, 지휘관이 일하는 중이면 그 사정으로. */
const launchFailure = (t: T, error: unknown): string => {
  const code = error instanceof Error ? error.message : "unknown";
  return code === "objective_busy" ? t("objectives.toast.busy") : hasRoutingReason(code) ? routingReason(t, code) : t("objectives.toast.failed", { code });
};

/** 활동 → 상태 낱말 — 데스크톱 명단과 같은 낱말. 세션이 없으면(closed) 말하지 않는다. */
function activityWord(state: string, t: T): string | null {
  if (state === "closed") return null;
  if (state === "ended") return t("objectives.members.dormant");
  if (state === "awaiting") return t("objectives.awaiting.word");
  return state === "running" || state === "background" ? t("objectives.members.working") : t("objectives.members.idle");
}

/** 구성원 행 머리의 배지 낱말 — 실패가 먼저, 세션이 없으면 맡은 임무 수, 아니면 상태 낱말. */
function memberBadge(member: ObjectiveMember, state: string, objective: Objective, t: T): { readonly text: string; readonly failed: boolean } {
  const working = state === "running" || state === "background" || state === "awaiting";
  if ((member.outcome === "failed" || !!member.failure) && !working) return { text: t("objectives.members.failed"), failed: true };
  if (state === "closed") return { text: t("objectives.members.missions", { count: objective.missions.filter((mission) => mission.member === member.id).length }), failed: false };
  return { text: activityWord(state, t) ?? "", failed: false };
}

/** 구성원 행의 예외 줄 — 이번 턴 뒤 예약, 바꾸지 못한 예약. 없으면 null. */
function memberNote(member: ObjectiveMember, state: string, rows: ReturnType<typeof useLaunchRows>, t: T): { readonly text: string; readonly failed: boolean } | null {
  const labels = { auto: t("objectives.commander.effortAuto"), fallback: t("objectives.launch.default") };
  const next = member.sessionName !== null && state !== "closed" ? member.next : null;
  if (!next) return null;
  if (!next.failed) {
    const words = launchedWords(rows, next.model, next.effort, labels).words;
    return { text: `${t("objectives.members.next.whenTurn")} → ${words.model} · ${words.effort}`, failed: false };
  }
  return { text: t("objectives.members.next.failedBody", { model: launchedWords(rows, next.model, next.effort, labels).title, reason: routingReason(t, next.failed) }), failed: true };
}

interface CrewActions {
  readonly send: (path: string, body: Record<string, unknown>) => Promise<{ objective?: Objective } | undefined>;
  readonly fail: (error: unknown) => void;
  readonly saving: ReadonlySet<string>;
  readonly memberState: (member: ObjectiveMember) => string;
  readonly toggleSubagents: (member: ObjectiveMember) => void;
}

/** 지휘관·구성원 묶음과 서브에이전트 묶음이 함께 쓰는 저장 경로 — 서브에이전트 저장 중 표시는 두 묶음이 같은 것을 본다. */
function useCrewActions(objective: Objective | null, operations: OperationIndex, t: T, api: PaneContext["api"], language: ConsoleLocale, say: (text: string) => void): CrewActions {
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const objectiveId = objective?.id ?? "";
  const send = (path: string, body: Record<string, unknown>) => post<{ objective?: Objective }>(api, path, { objectiveId, ...body, language });
  const fail = (error: unknown) => say(launchFailure(t, error));
  const memberState = (member: ObjectiveMember) => (member.sessionName !== null ? activityOf(operations, member.id) : "closed");
  const toggleSubagents = (member: ObjectiveMember) => {
    if (saving.has(member.id)) return;
    const live = MEMBER_LIVE.has(memberState(member));
    const next = !memberSubagents(member);
    setSaving((current) => new Set(current).add(member.id));
    const done = () => setSaving((current) => { const updated = new Set(current); updated.delete(member.id); return updated; });
    send("/member/patch", { memberId: member.id, patch: { subagents: next } }).then((payload) => {
      done();
      const echoed = payload?.objective?.members.find((entry) => entry.id === member.id);
      if (!echoed || memberSubagents(echoed) !== next) { say(t("objectives.toast.failed", { code: "not_stored" })); return; }
      say(`${t(next ? "objectives.members.subagentsSaved" : "objectives.members.subagentsCleared", { role: member.role })}${live ? ` ${t("objectives.members.subagentsLive")}` : ""}`);
    }, (error: unknown) => { done(); fail(error); });
  };
  return { send, fail, saving, memberState, toggleSubagents };
}

/**
 * 한 사람의 행 안 조작부 — 세션이 있으면 첫 조작부가 「세션 열기」(›)다. 호스트 모바일 행은 <label>이라 행 어디를 눌러도 첫 조작부가
 * 대신 눌리므로 행 탭 = 세션 열기이고, 값 칩(단추)을 직접 누르면 칩만 눌려 좌표 시트가 선다. 세션이 없으면 첫 조작부가 칩이라 행 탭 = 시트다.
 * 잠긴 값은 단추가 아니라 자물쇠 + 값 글자이고, 잠긴 사유는 보이는 문장 대신 보조기술용 설명으로만 둔다.
 */
function CrewControls({ open, role, locked, lockedNote, note, t, children }: { readonly open: (() => void) | null; readonly role: string; readonly locked: boolean; readonly lockedNote?: string; readonly note: { readonly text: string; readonly failed: boolean } | null; readonly t: T; readonly children: ReactNode }) {
  return (
    <>
      {open ? (
        <button type="button" className="objectives-m-open" aria-label={t("objectives.decision.openSession", { role })} onClick={open}>
          <Chevron open={false} />
        </button>
      ) : null}
      {/* 좌표 시트(스크림)는 DOM 으로도 이 행 <label> 안에 그려진다 — 시트 안·바깥 탭이 label 활성화로 › 를 눌러 세션을 열지 않게 그 기본 동작만 막는다. */}
      <span className={`objectives-m-val${locked ? " is-locked" : ""}`} onClickCapture={(event) => { if (event.target instanceof Element && event.target.closest(".mobile-choice-scrim")) event.preventDefault(); }}>
        {locked ? <LockIcon /> : null}
        {children}
        {lockedNote ? <span className="objectives-m-sr">{lockedNote}</span> : null}
      </span>
      {note ? <span className={`objectives-m-note-line${note.failed ? " is-failed" : ""}`}>{note.text}</span> : null}
    </>
  );
}

/**
 * 지휘관·구성원 — 호스트의 모바일 설정 묶음 한 장이 세션 진입과 모델·강도를 함께 진다. 행(글리프 · 이름 · 배지 / 세션 제목 / 값 칩 /
 * 예외 줄 · ›)을 누르면 그 세션이 열리고, 값 칩을 누르면 공유 선택기가 좌표 시트로 선다. 모델과 강도를 차례로 골라도 시트가 닫힐 때 한 번만
 * 저장한다(데스크톱 메뉴와 같은 확정 규칙). 구성원 전용 「라우팅」·「지휘관과 같게」는 시트 맨 위 묶음이다. 세션 판정은 지휘관 = Operation 이
 * 있거나 개시함, 구성원 = 세션 이름이 있음이다. 지휘관은 데스크톱과 같이 개시 전에만 바꾼다.
 */
function CrewSection({ objective, operations, t, crew }: { readonly objective: Objective; readonly operations: OperationIndex; readonly t: T; readonly crew: CrewActions }) {
  const rows = useLaunchRows();
  const touchable = !objective.done;
  const commanderOperation = operations.get(objective.id);
  const commanderState = ownActivityOf(operations, objective.id);
  const commanderLocked = !touchable || objective.commander.started || COMMANDER_LIVE.has(commanderState) || WORKING.has(activityOf(operations, objective.id));
  const commanderSession = !!commanderOperation || objective.commander.started;
  // 지휘관 제목이 목표 제목과 같으면 상단 막대가 이미 말한다.
  const commanderTitle = commanderOperation && commanderOperation.title !== objective.title ? commanderOperation.title : undefined;
  const commanderWord = activityWord(commanderState, t);
  const patchMember = (member: ObjectiveMember, launch: MemberLaunchChoice | null) => { crew.send("/member/patch", { memberId: member.id, patch: { launch } }).catch(crew.fail); };
  return (
    <SettingsCard title={t("objectives.mobile.crew")}>
      <SettingsRow label={t("objectives.commander.title")} icon={<StatusMark state={activityGlyph(commanderOperation ? commanderOperation.ownActivity ?? commanderOperation.activity : undefined)} />}
        {...(commanderWord ? { badge: <span className="objectives-m-badge">{commanderWord}</span> } : {})}
        {...(commanderTitle ? { hint: commanderTitle } : {})}>
        <CrewControls open={commanderSession ? () => focusOperation(objective.id) : null} role={t("objectives.commander.title")} locked={commanderLocked} note={null} t={t}
          {...(commanderLocked && touchable ? { lockedNote: t("objectives.commander.locked") } : {})}>
          <LaunchControl t={t} model={objective.commander.model} effort={objective.commander.effort} locked={commanderLocked}
            onChange={(next) => { crew.send("/objective/patch", { patch: { launch: next } }).catch(crew.fail); }} />
        </CrewControls>
      </SettingsRow>
      {objective.members.map((member) => {
        const state = crew.memberState(member);
        const badge = memberBadge(member, state, objective, t);
        const session = member.sessionName !== null;
        const title = session ? operations.get(member.id)?.title ?? member.sessionName ?? undefined : undefined;
        return (
          <SettingsRow key={member.id} label={member.role} icon={<StatusMark state={session ? activityGlyph(operations.get(member.id)?.activity) : "fresh"} />}
            badge={<span className={`objectives-m-badge${badge.failed ? " is-failed" : ""}`}>{badge.text}{memberSubagents(member) ? t("objectives.members.subagentsMark") : ""}</span>}
            {...(title ? { hint: title } : {})}>
            <CrewControls open={session ? () => focusOperation(member.id) : null} role={member.role} locked={!touchable} note={memberNote(member, state, rows, t)} t={t}>
              <MemberLaunchControl t={t} objective={objective} member={member} state={state} rows={rows} touchable={touchable}
                onPickLaunched={(launch) => patchMember(member, launch)}
                onPatchLaunch={(launch) => patchMember(member, launch)}
                onToggleSubagents={() => crew.toggleSubagents(member)} />
            </CrewControls>
          </SettingsRow>
        );
      })}
    </SettingsCard>
  );
}

/**
 * 서브에이전트 허용 — 데스크톱 메뉴 바닥의 켬/끔은 시트를 닫지 않는 설정이라, 폰에서는 시트 밖의 따로 선 설정 전용 묶음(구성원마다
 * 스위치 하나)으로 맨 아래에 둔다. 켠 상태는 위 행의 배지도 말한다. 끝난 목표에서는 서지 않는다.
 */
function SubagentsSection({ objective, t, crew }: { readonly objective: Objective; readonly t: T; readonly crew: CrewActions }) {
  if (objective.done || objective.members.length === 0) return null;
  return (
    <SettingsCard title={t("objectives.members.subagents")} description={t("objectives.members.subagentsHint")}>
      {objective.members.map((member) => (
        <SettingsRow key={member.id} label={member.role}>
          <SettingsToggle checked={memberSubagents(member)} busy={crew.saving.has(member.id)} ariaLabel={`${member.role} · ${t("objectives.members.subagents")}`} onChange={() => crew.toggleSubagents(member)} />
        </SettingsRow>
      ))}
    </SettingsCard>
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
          {overflows || open ? <button type="button" data-press="r1" className="objectives-m-more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{t(open ? "objectives.mobile.brief.less" : "objectives.mobile.brief.more")}</button> : null}
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

// ── 달성 기준 제안 ──

/**
 * 지휘관의 달성 기준 제안 — 줄마다 거절·승인, 2건 이상이면 「모두 승인」. 제안이 남아 있으면 서버가 개시·스티어링을
 * `criteria_pending`으로 거부하므로, 폰에서도 이 카드로 풀 수 있어야 한다. 데스크톱 `ProposalRow`와 같은 경로(/criterion/*)이고
 * 어노테이션·「다시 구상」·기준 직접 편집은 데스크톱에만 둔다.
 */
function ProposalsCard({ objective, t, language, api, say }: { readonly objective: Objective; readonly t: T; readonly language: ConsoleLocale; readonly api: PaneContext["api"]; readonly say: (text: string) => void }) {
  // 보낸 요청이 돌아올 때까지 모든 단추를 잠근다 — 두 번 눌러 이미 처리된 제안에 다시 보내지 않게.
  const [busy, setBusy] = useState(false);
  const proposals = objective.criteriaProposals;
  if (proposals.length === 0) return null;
  const touchable = !objective.done;
  const send = (path: "/criterion/approve" | "/criterion/reject" | "/criterion/approve-all", proposalId?: string) => {
    setBusy(true);
    void post(api, path, { objectiveId: objective.id, ...(proposalId ? { proposalId } : {}), language })
      .catch((error: unknown) => say(launchFailure(t, error)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="objectives-m-card objectives-m-props" aria-label={t("objectives.criteria.title")}>
      <h3 className="objectives-m-card-label">{t("objectives.criteria.pending", { count: proposals.length })}</h3>
      {proposals.map((proposal) => {
        const index = proposal.target ? objective.criteria.findIndex((criterion) => criterion.id === proposal.target) : -1;
        const target = index >= 0 ? objective.criteria[index]! : null;
        const n = index + 1;
        const label = proposal.kind === "add" ? t("objectives.proposal.add") : t(proposal.kind === "revise" ? "objectives.proposal.revise" : proposal.kind === "recheck" ? "objectives.proposal.recheck" : "objectives.proposal.retire", { n });
        return (
          <div key={proposal.id} className="objectives-m-prop" role="group" aria-label={label}>
            <p className="objectives-m-prop-kind">{label}</p>
            {proposal.kind === "revise" && target ? <del className="objectives-m-prop-tx is-old"><LinkText text={target.text} /></del> : null}
            {proposal.kind === "retire" ? <del className="objectives-m-prop-tx"><LinkText text={target?.text ?? ""} /></del>
              : proposal.kind === "recheck" ? <p className="objectives-m-prop-tx"><LinkText text={target?.text ?? ""} /></p>
              : <p className="objectives-m-prop-tx"><LinkText text={proposal.text ?? ""} /></p>}
            {proposal.reason && (proposal.kind === "retire" || proposal.kind === "recheck") ? <p className="objectives-m-prop-sub"><LinkText text={t("objectives.proposal.reason", { reason: proposal.reason })} /></p> : null}
            {proposal.kind === "recheck" ? <p className="objectives-m-prop-sub">{t("objectives.proposal.recheckHint")}</p> : null}
            {touchable ? (
              <div className="objectives-m-prop-acts">
                <button type="button" data-press="r3" className="objectives-m-pbtn is-reject" disabled={busy} onClick={() => send("/criterion/reject", proposal.id)}>{t("objectives.proposal.reject")}</button>
                <button type="button" data-press="r3" className="objectives-m-pbtn is-approve" disabled={busy} onClick={() => send("/criterion/approve", proposal.id)}>{t("objectives.proposal.approve")}</button>
              </div>
            ) : null}
          </div>
        );
      })}
      {touchable && proposals.length > 1 ? (
        <button type="button" data-press="r3" className="objectives-m-pbtn is-approve objectives-m-approve-all" disabled={busy} onClick={() => send("/criterion/approve-all")}>{t("objectives.criteria.approveAll")}</button>
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
  // 자율 운영이 실제로 돌면 사령관이 이 요청에 답한다 — 데스크톱 결정 카드 머리 메모와 같은 판정(S-53 CM-1d). 폰에는 툴팁이 없어 설명을 줄로 보인다.
  const commodore = useCommodoreBoard(objective.theaterId);
  // 사람이 운영하는 목표의 요청으로는 사령관이 깨어나지 않는다(서버 판정 `operator`).
  const answering = commodore.active && objective.operator !== "human";
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
              <div className="objectives-m-ucard-hd"><StatusMark state="review" />{head}{index === 0 && answering ? <span className="objectives-m-ucard-handler">{t("objectives.commodore.note.answering")}</span> : null}</div>
              {index === 0 && answering ? <p className="objectives-m-fine">{t("objectives.commodore.decisionHint")}</p> : null}
              <p className="objectives-m-ucard-p is-question"><LinkText text={question.text} /></p>
              {hasOptions && question.multiSelect ? <p className="objectives-m-hint">{t("objectives.decision.multiHint")}</p> : null}
              {hasOptions ? (
                <div role={question.multiSelect ? "group" : "radiogroup"} aria-label={t("objectives.decision.optionsAria", { n: index + 1 })}>
                  {question.options.map((option) => {
                    const on = !draft.own && draft.picked.includes(option.id);
                    return (
                      <button key={option.id} type="button" role={question.multiSelect ? "checkbox" : "radio"} aria-checked={on} disabled={sending} data-press="r1" className="objectives-m-opt" onClick={() => pick(question, option.id)}>
                        <span className={`${indicator}${on ? " is-on" : ""}`} aria-hidden="true">{question.multiSelect && on ? <CheckIcon size={14} /> : null}</span>
                        <span className="objectives-m-opt-tx">{option.label}{option.description ? <small>{option.description}</small> : null}</span>
                      </button>
                    );
                  })}
                  <button type="button" role={question.multiSelect ? "checkbox" : "radio"} aria-checked={draft.own} disabled={sending} data-press="r1" className="objectives-m-opt" onClick={() => pickOwn(question)}>
                    <span className={`${indicator}${draft.own ? " is-on" : ""}`} aria-hidden="true">{question.multiSelect && draft.own ? <CheckIcon size={14} /> : null}</span>
                    <span className="objectives-m-opt-tx">{t("objectives.decision.own")}</span>
                  </button>
                </div>
              ) : null}
              {!hasOptions || draft.own ? (
                <textarea
                  className={`objectives-m-field${hasOptions ? " is-unfold" : ""}`}
                  maxLength={50}
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
                  <button type="button" data-press="r3" className="objectives-m-b2" disabled={sending || doneCount !== total} onClick={() => void submit()}>
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
          <button type="button" data-press="r1" className="objectives-m-sheet-x" aria-label={t("objectives.detail.close")} onClick={close}><CloseIcon /></button>
        </div>
        <div className="objectives-m-sheet-body">
          <div className="objectives-m-chips" role="radiogroup" aria-label={t("objectives.message")}>
            {recipients.map((candidate) => (
              <button key={candidate.id} type="button" role="radio" aria-checked={candidate.id === recipient?.id} data-press="r3" className={`objectives-m-pill2${candidate.id === recipient?.id ? " is-inv" : ""}`} onClick={() => { setTo(candidate.id); setError(null); }}>{candidate.role}</button>
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
          <button type="button" data-press="r3" className="objectives-m-pill2 is-inv" disabled={!recipient || blocked || sending || !text.trim()} onClick={() => void send()}>
            {t(sending ? "objectives.decision.sending" : "objectives.mobile.message.send")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
