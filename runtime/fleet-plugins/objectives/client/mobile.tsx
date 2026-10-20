import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { ConsoleOperationSummary } from "@fleet-console/sdk/plugin";
import type { MobileBarMenuItem, PaneContext } from "@fleet-console/sdk/pane";
import type { RailEntryAttentionItem, RailEntryFinishedItem } from "@fleet-console/sdk/rail";
import { SettingsCard, SettingsRow, SettingsToggle, useMobileSettingsHost } from "@fleet-console/sdk/settings/browser";

import { livePersonHold } from "../server/board-state.js";
import { MAX_DECISION_ANSWER_INPUT, ROUTING_PREVIEW_TTL_MS, type Decision, type DecisionQuestion, type Objective, type ObjectiveMember, type RoutingPreview } from "../server/types.js";
import { bandChoices, bandFailure } from "./board-actions.js";
import { commodoreBoardOf, decisionTurn, openAsks, openCommodoreMobile, personTurnAt, subscribeCommodore, useCommodoreBoard } from "./commodore-state.js";
import type { CommodoreAsk } from "../server/commodore/types.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { hasRoutingReason, LaunchControl, launchedWords, MEMBER_LIVE, MemberLaunchControl, memberActivityWord, memberLaunched, memberStatus, memberSubagents, routingReason, useLaunchRows, type MemberLaunchChoice } from "./launch-control.js";
import { ObjectiveLinkOpenProvider } from "./link-open-context.js";
import { commanderMongleState, memberMongleState, ObjectiveAvatar } from "./objective-avatar.js";
import { LinkText } from "./link-text.js";
import { PersonHoldNote } from "./decisions.js";
import { clearSelection, discardedFollowups, followupHoldRoute, isFollowupSelectable, newBatchId, openFollowups, pruneSelection, readBatches, readHistory, readSelectionRevs, steeredEdits, toggleFollowupSelection, useFollowupSelection } from "./followups.js";
import { FollowupBatchResults, FollowupCandidateList, FollowupDiscardedTrace } from "./followups-view.js";
import { ObjectiveResults } from "./results.js";
import { Retrospective } from "./retrospective.js";
import { DatePicker } from "./date-picker.js";
import { CalGlyph, DETAIL_TABS, detailTabOf, dueLabel, dueShort, SunGlyph, todayIso, type DetailTab } from "./objectives-panel.js";
import { viewedTheaterId, ensureFinishedObjectives, findAnyObjective, finishedObjectives, focusOperation, hasDecisionRequest, loadFinishedObjectives, openObjectiveOnPhone, patchObjectiveView, post, returnPersonHold, readAllTheaters, readTheater, subscribeFinishedObjectivesStore, subscribeObjective, subscribeObjectiveOrFinished, takeReveal, upsertObjectiveLocally, useObjectiveView, useOperationSummaries, useReveal } from "./objectives-state.js";
import "./mobile.css";

/**
 * 폰의 목표 — 상세(브리핑·달성 기준·결정 요청·지휘관·구성원·임무·결과물) 하나를 두 자리에 세운다. 폰에는 목표 목록(보드)이 없다.
 * 대화 정보 화면의 「목표」 탭(호스트가 `mobile.conversationPane` 으로 대화 주인 Operation 을 싣는다, 막대 없음 — 동작은 본문 맨 위 줄)과,
 * 지휘관 Operation 이 없는 목표가 착지하는 목표 화면(칩 없는 목적지, 호스트가 `mobileBar` 를 싣는다 — 제목·⋮ 항목만 선언한다)이다.
 * 데스크톱 보드와 같은 스토어·같은 API를 쓴다 — 결정 답·메시지·완료·인계·중단·개시 모두 보드와 같은 경로이고, ⋮ 와 개시 카드의
 * 노출 판정도 구성원 채팅 입력창의 보드 동작과 같은 판정(`bandChoices`)을 쓴다. 지휘관·구성원의 모델·강도는 데스크톱 명단과 같은 어댑터(`LaunchControl`)이고,
 * 호스트의 모바일 설정 문법 안에서 공유 선택기가 좌표 시트로 선다.
 */

type T = Translate<ObjectiveMessageKey>;

export const OBJECTIVE_MOBILE_DETAIL_PANE = "objectives-mobile-detail";

const TOAST_MS = 6_000;
const SHEET_CLOSE_MS = 220;
const SHEET_DISMISS_PX = 110;
const SHEET_DRAG_SLOP_PX = 6;
const WORKING = new Set(["running"]);
/** 시안 아이콘 문법 — 24 viewBox, 선 1.7, 둥근 끝. */
const Icon = ({ children, size = 20 }: { readonly children: ReactNode; readonly size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const Chevron = ({ open, size }: { readonly open: boolean; readonly size?: number }) => <Icon size={size ?? 22}><path d={open ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} /></Icon>;
const MessageIcon = () => <Icon><path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /><path d="M12 7.5v6M9 10.5h6" /></Icon>;
const CheckIcon = ({ size }: { readonly size?: number }) => <Icon size={size ?? 20}><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>;
const SendIcon = () => <Icon><path d="M12 19V5M6 11l6-6 6 6" /></Icon>;
/** 호스트 모바일 ⋮의 보관·이름 변경 아이콘과 같은 모양. */
const ArchiveIcon = () => <Icon><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10h14V9M10 13h4" /></Icon>;
const PencilIcon = () => <Icon><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></Icon>;
const StopIcon = () => <Icon><rect x="7.5" y="7.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" /></Icon>;
const CloseIcon = () => <Icon><path d="M6 6l12 12M18 6L6 18" /></Icon>;
const LockIcon = () => <Icon size={14}><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></Icon>;

/** 턴 뒤에 남은 백그라운드 작업(background)은 화면에서 진행 중(running)이다 — 색인을 세울 때 한 번 접는다. */
const shownActivity = <A extends string | undefined>(activity: A) => (activity === "background" ? "running" : activity) as A;
const shownOperation = (operation: ConsoleOperationSummary): ConsoleOperationSummary => operation.activity !== "background" && operation.ownActivity !== "background" ? operation : {
  ...operation,
  activity: shownActivity(operation.activity),
  ...(operation.ownActivity === undefined ? {} : { ownActivity: shownActivity(operation.ownActivity) }),
};
const operationIndex = (operations: readonly ConsoleOperationSummary[]) => new Map(operations.map((operation) => [operation.id, shownOperation(operation)]));
type OperationIndex = ReturnType<typeof operationIndex>;
const activityOf = (operations: OperationIndex, id: string): string => operations.get(id)?.activity ?? "closed";
/** 지휘관 자신의 활동 — 코어가 구성원 활동을 끌어올리기 전 값. 보드와 같은 셈이다. */
const ownActivityOf = (operations: OperationIndex, id: string): string => { const operation = operations.get(id); return operation ? operation.ownActivity ?? operation.activity : "closed"; };

/**
 * 지휘관 표식 — 목표 Operation 의 몽글 아바타. 데스크톱 보드·사이드바와 같은 기준(검토 대기 › 결정 요청 › 구성원 활동을 끌어올린 활동)이다.
 * 표식은 장식이다 — 이름은 곁의 글자가 말한다.
 */
const CommanderMark = ({ objective, operations }: { readonly objective: Objective; readonly operations: OperationIndex }) =>
  <ObjectiveAvatar operationId={objective.id} role="commander" state={commanderMongleState(objective, activityOf(operations, objective.id))} />;
/** 구성원 표식 — 그 구성원 Operation 의 몽글 아바타. 세션이 아직 없으면 시작 전 얼굴이다. */
const MemberMark = ({ objective, member, operations }: { readonly objective: Objective; readonly member: ObjectiveMember; readonly operations: OperationIndex }) =>
  <ObjectiveAvatar operationId={member.id} role="member" state={memberMongleState(objective, member.id, member.sessionName !== null ? activityOf(operations, member.id) : "closed")} />;

const criteriaMet = (objective: Objective) => objective.criteria.filter((criterion) => criterion.met !== undefined).length;
/** 결정은 요청 단위로 센다 — 목표마다 요청은 하나이고, 질문이 여럿이어도 「결정 요청 1건」이다. */
const requestCount = (objective: Objective) => (hasDecisionRequest(objective) ? 1 : 0);
/**
 * 목록에 서는 목표 — 기록이 없는 항목(`recorded === false`, 따로 만든 에이전트 Operation 이 「목표 밖」에 선 것)은 목표가 아니다.
 * 데스크톱 보드는 그것을 「목표 밖」으로 가르지만, 모바일 목표 화면에는 그 구역이 없다.
 */
const isListedObjective = (objective: Objective) => !objective.removed && objective.recorded !== false;

/**
 * 모든 Theater 에서 목표 하나 — 「확인 필요」에서 다른 Theater 의 목표로 와도 찾는다. 살아 있는 목록에 없으면 「끝남」(보관된 완료 목표)에서 찾는다.
 * 같은 상태면 같은 참조.
 */
const findObjective = findAnyObjective;
const useObjective = (objectiveId: string) => useSyncExternalStore(subscribeObjectiveOrFinished, () => findObjective(objectiveId), () => findObjective(objectiveId));

// ── 「확인 필요」 행 ──

const NO_ITEMS: readonly RailEntryAttentionItem[] = [];
const attentionMemo = new Map<string, { readonly source: readonly Objective[]; readonly asks: readonly CommodoreAsk[]; readonly locale: ConsoleLocale; readonly answering: boolean; readonly items: readonly RailEntryAttentionItem[] }>();

/** 「확인 필요」 행의 갱신 신호 — 목표 상태와 사령관 상태(답하는 중 메모)가 모두 행을 바꾼다. */
export function subscribeDecisionAttention(listener: () => void): () => void {
  const offObjective = subscribeObjective(listener);
  const offCommodore = subscribeCommodore(listener);
  return () => { offObjective(); offCommodore(); };
}

/**
 * 레일 아이콘 배지의 수 — 「확인 필요」 행·사이드바 「내 결정」과 같은 판정이라 사람의 차례만 센다: 사람이 답할 목표(`personTurnAt`)와
 * 사령관이 사람에게 직접 물은 질문(`openAsks`). 표면이 닫혀 있어도 활성 Theater 는 미리 읽혀 있다(installObjectiveState).
 */
export function personTurnCount(theaterId: string | null): number {
  const active = theaterId !== null && commodoreBoardOf(theaterId).active;
  return readTheater(theaterId).objectives.filter((objective) => isListedObjective(objective) && personTurnAt(objective, active) !== null).length + openAsks(theaterId).length;
}

/**
 * 사람의 차례마다 한 행 — 사령관의 질문(누르면 사령관 화면의 질문 카드), 사람이 답할 결정 요청과 사령관이 사람에게 넘긴 항목. 자율 운영 중 사령관이 맡은 요청은 세지 않는다
 * (데스크톱 「내 결정」 구역과 같은 판정 `personTurnAt`). 스냅샷이므로 같은 목록 상태·같은 언어면 같은 배열을 돌려준다.
 */
export function decisionAttentionItems(theaterId: string | null, locale: ConsoleLocale): readonly RailEntryAttentionItem[] {
  const source = readTheater(theaterId).objectives;
  const key = theaterId ?? "";
  const answering = theaterId !== null && commodoreBoardOf(theaterId).active;
  const asks = openAsks(theaterId);
  const hit = attentionMemo.get(key);
  if (hit && hit.source === source && hit.asks === asks && hit.locale === locale && hit.answering === answering) return hit.items;
  const t = getT(locale, true);
  const pending = source.filter((objective) => isListedObjective(objective) && personTurnAt(objective, answering) !== null);
  const items = pending.length === 0 && asks.length === 0 ? NO_ITEMS : [
    ...asks.map((ask) => ({ id: `ask:${ask.id}`, title: ask.questions[0]?.text ?? "", reason: t("objectives.ask.title"), open: () => openCommodoreMobile("log", theaterId) })),
    ...pending.map((objective) => ({
      id: objective.id,
      clusterId: objective.id,
      title: objective.title,
      reason: decisionTurn(objective, answering) === "person" ? t("objectives.mobile.attention", { count: requestCount(objective) }) : t("objectives.commodore.note.handed"),
      open: () => openObjectiveOnPhone(objective.id, objective.theaterId),
    })),
  ];
  attentionMemo.set(key, { source, asks, locale, answering, items });
  return items;
}

// ── 홈 「끝남」 ──

/** 「끝남」의 원천은 objectives-state 의 끝난 목표 저장소다 — 살아 있는 목록의 명단이 바뀔 때(사람이 보관해 빠졌거나 복원돼 돌아왔다)와 Theater 를 바꿀 때 다시 읽는다. */
let finishedRoster = "";

/** 지금 Theater 의 살아 있는 명단이 바뀌었으면 「끝남」을 다시 읽는다. */
function followFinished(): void {
  const theaterId = viewedTheaterId();
  if (!theaterId) return;
  const state = readTheater(theaterId);
  if (!state.loaded) return;
  const roster = `${theaterId}|${state.objectives.map((objective) => objective.id).join(",")}`;
  if (roster === finishedRoster) return;
  finishedRoster = roster;
  loadFinishedObjectives(theaterId);
}

/** 「끝남」 행의 갱신 신호 — 목표 상태가 바뀌면 명단을 살피고, 보관된 목표를 다시 읽으면 알린다. */
export function subscribeFinishedObjectives(listener: () => void): () => void {
  const offFinished = subscribeFinishedObjectivesStore(listener);
  const off = subscribeObjective(() => { followFinished(); listener(); });
  followFinished();
  return () => { offFinished(); off(); };
}

/**
 * 폰 홈 「끝남 N」 섹션의 행(`RailEntryMobile.finished`) — 지금 Theater 에서 사람이 보관한 완료 목표, 최근에 끝난 것부터. 완료는 보관하지 않으므로
 * 보관하지 않은 완료 목표는 호스트가 묶음 줄(glyph done)로 같은 「끝남」에 모으므로 여기서는 보관한 것만 올린다(살아 있는 명단과 겹치지 않는다). 복원돼 다시 살아 있는 목록에 선 목표도 그 대화 행이 받으므로 뺀다. 누르면 복원 없이 목표 화면이 그 목표를 읽기 전용으로 보인다(`openObjectiveOnPhone`).
 */
export function finishedObjectiveItems(theaterId: string | null, locale: ConsoleLocale): readonly RailEntryFinishedItem[] {
  if (theaterId === null) return [];
  const t = getT(locale, true);
  const live = new Set(readTheater(theaterId).objectives.map((objective) => objective.id));
  return finishedObjectives(theaterId)
    .filter((objective) => isListedObjective(objective) && !!objective.done && !live.has(objective.id))
    .map((objective) => {
      // 구성원 수는 명단(roster) 그대로다 — 지휘관은 구성원이 아니다(보드·데이터와 같은 셈).
      const members = objective.members.length;
      const total = objective.criteria.length;
      return {
        id: objective.id,
        title: objective.title,
        detail: total > 0 ? t("objectives.mobile.row.summary", { members, met: criteriaMet(objective), total }) : t("objectives.mobile.row.members", { members }),
        avatarOperationId: objective.id,
        open: () => openObjectiveOnPhone(objective.id, objective.theaterId),
      };
    });
}

// ── 목표 화면 ──

/**
 * 폰의 목표 화면 — 칩 없는 목적지(`destination.chip: false`)의 본문이다. 목표 목록은 폰에 없고, 이 화면의 입구는 플러그인의 착지(`openObjectiveOnPhone`)뿐이다:
 * 지휘관 Operation 이 없는 목표나 대화 탭이 서지 못한 목표를 reveal(또는 호스트가 돌려준 params)로 받아 그 상세를 뿌리(depth 0)로 세운다 — ‹ 는 홈이다.
 * 고른 목표는 페인 params(`objectiveId`)에 두어 호스트의 목적지 주소로 새로고침을 넘긴다.
 */
export function MobileObjectiveScreen({ ctx }: { readonly ctx: PaneContext }) {
  const reveal = useReveal();
  const { panes } = ctx;
  // 보이는 목표는 페인 주소(params)가 든다 — 호스트가 목적지 주소에 옮겨 적어, 새로고침·딥링크에도 같은 목표가 선다.
  // 착지는 reveal 로 오거나(시작 전 줄·질문 카드) 호스트가 대화 탭 대신 돌려준 `operationId` 로 온다 — 둘 다 `objectiveId` 하나로 고쳐 적는다.
  // primary params 는 화면을 닫아도 남는다(호스트 계약) — 새 착지의 reveal 이 아직 집히기 전이면 그것을 먼저 그려 옛 목표가 한 번 비치지 않게 한다.
  const objectiveId = reveal?.objectiveId ?? ctx.params.objectiveId ?? ctx.params.operationId ?? "";
  useEffect(() => {
    if (!reveal) return;
    const target = takeReveal();
    if (target) panes.replaceParams({ objectiveId: target.objectiveId });
  }, [reveal, panes]);
  useEffect(() => {
    if (ctx.params.objectiveId === undefined && ctx.params.operationId) panes.replaceParams({ objectiveId: ctx.params.operationId });
  }, [ctx.params.objectiveId, ctx.params.operationId, panes]);
  // 보관된 끝난 목표로 착지했다면(「끝남」 행·새로고침) 그 목록을 아직 읽지 않았을 수 있다.
  const known = useSyncExternalStore(subscribeObjectiveOrFinished, () => findObjective(objectiveId) !== null, () => findObjective(objectiveId) !== null);
  useEffect(() => { if (objectiveId && !known) ensureFinishedObjectives(ctx.theaterId); }, [objectiveId, known, ctx.theaterId]);
  // 시작 화면에서 개시해 지휘관 Operation 이 서면 그 대화로 넘긴다 — 보는 동안 새로 선 때만이다(이미 Operation 이 있는 목표로 착지했으면 그대로 둔다).
  const hasCommander = useOperationSummaries().some((operation) => operation.id === objectiveId);
  const seen = useRef<{ readonly id: string; readonly had: boolean } | null>(null);
  useEffect(() => {
    if (!objectiveId) return;
    const previous = seen.current;
    seen.current = { id: objectiveId, had: hasCommander };
    if (previous?.id === objectiveId && !previous.had && hasCommander && ctx.visible) focusOperation(objectiveId);
  }, [objectiveId, hasCommander, ctx.visible]);
  return <MobileObjectiveDetail ctx={ctx} objectiveId={objectiveId} />;
}

/** 대화 주인 Operation 의 목표 — 지휘관 Operation 이면 그 목표, 구성원 Operation 이면 그 구성원이 속한 목표. 같은 상태면 같은 참조. */
export function objectiveOfOperation(operationId: string): Objective | null {
  for (const state of readAllTheaters()) {
    const found = state.objectives.find((objective) => isListedObjective(objective) && (objective.id === operationId || objective.members.some((member) => member.id === operationId)));
    if (found) return found;
  }
  return null;
}

// ── 상세 ──

interface Recipient { readonly id: string; readonly role: string; readonly state: string }
/** 띠가 지금 「완료」를 세우지 못하는 사정 — 누르기 전의 상태다(거절 문구가 아니다). */
type FinishBlock = "awaiting" | "working" | "gated" | "steer" | "notInReview";

interface ObjectiveActions {
  readonly recipients: readonly Recipient[];
  readonly message: boolean;
  readonly complete: boolean;
  readonly handOff: boolean;
  readonly stop: boolean;
  /**
   * 개시 카드 — null 이면 서지 않는다. 띠가 개시·재개를 고를 수 있으면 누를 수 있고, 아니면 reason 이 막힌 사정을 말한다.
   * review 는 개시가 라우팅으로 새로 띄울 구성원이다 — 라우팅 확인이 켜져 있을 때만 차고, 차 있으면 개시는 확인 시트를 거친다.
   */
  readonly commence: { readonly kind: "start" | "resume"; readonly reason: string | null; readonly review: readonly ObjectiveMember[]; readonly primary: boolean } | null;
  /**
   * 완료 검토 — 검토 대기일 때만 선다. blocked 는 띠가 지금 「완료」를 세우지 못하는 사정(띠의 판정 순서와 같다), null 이면
   * 누를 수 있다. followups 는 완료가 후속 후보 고르기를 거쳐야 하는가(띠의 followupAvailable) — 그러면 완료는 고르기 시트를 연다.
   */
  readonly finish: { readonly blocked: FinishBlock | null; readonly followups: boolean } | null;
}

/**
 * ⋮ 의 사람 동작 — 데스크톱 하단 띠와 같은 판정에서, 폰에서 의미 있는 넷(메시지·완료·검토로 넘기기·중단)만 고른다.
 * 개시는 ⋮ 가 아니라 본문 카드로 세운다(누름 한 번). 덧붙일 말 칸은 폰에 없으므로 바로 `/commander/start` 를 보내고,
 * 라우팅 확인이 걸리는 개시(확인 켬 + 아직 띄우지 않은 라우팅 구성원)는 데스크톱 띠처럼 확인 시트를 거쳐 본 결과로만 띄운다.
 * 제안 대기(띠가 잠김)·작업 중에는 카드가 막힌 채 서서 이유를 말하고, 그 밖의 다른 할 일이 먼저인 상태에서는 서지 않는다.
 */
function objectiveActions(objective: Objective, operations: OperationIndex, t: T, launchAvailable: boolean): ObjectiveActions {
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
  const kind: "start" | "resume" = !has("start") && objective.commander.started ? "resume" : "start";
  // 데스크톱 띠의 routingTargets 와 같은 판정 — 아직 띄우지 않은 라우팅 구성원. 개시는 늘 그 판단 결과를 먼저 확인한다.
  const review = objective.members.filter((member) => member.launch.mode === "route" && !memberLaunched(member, (id) => activityOf(operations, id)));
  // 띠의 주 동작이 개시·재개일 때 개시 카드가 주 단추다 — 폰에 있는 다른 할 일(답·인계·완료 등)이 먼저면 보조 단추로 내려 다음 걸음이 둘로 갈리지 않게 한다.
  // 띠의 주 동작이 폰에 없는 것(구상·재구상·스티어링·확장)이면 이 화면에서 경쟁할 걸음이 없으므로 개시가 주 단추다.
  const primary = choices.primary === "start" || choices.primary === "resume" || (choices.primary !== null && !PHONE_STEPS.has(choices.primary));
  const commence = done ? null
    : has("start") || has("resume")
      ? { kind, reason: !launchAvailable ? t("objectives.band.reason.unavailable") : null, review, primary }
      : choices.gated ? { kind, reason: t("objectives.band.gated", { count: objective.criteriaProposals.length }), review, primary }
        : working ? { kind, reason: t("objectives.mobile.commence.working"), review, primary } : null;
  const finish: ObjectiveActions["finish"] = done || !objective.awaitingReview ? null : {
    blocked: choices.primary === "complete" && !choices.gated ? null
      : commanderAwaiting ? "awaiting"
        : working ? "working"
          : memberAwaiting ? "awaiting"
            : choices.gated ? "gated"
              : steeredEdits(objective) ? "steer" : "notInReview",
    followups: choices.followupAvailable,
  };
  // 후속 후보가 있으면 완료는 띠처럼 곧바로 하지 않고 후보 고르기 시트를 거친다(finish.followups).
  return { recipients, message: has("message"), complete: has("complete"), handOff: has("handOff"), stop: has("stop"), commence, finish };
}

/** 폰 상세가 직접 세우는 띠의 걸음 — 결정 답(본문 카드)과 동작 줄의 메시지·완료·검토로 넘기기·중단. 구상·스티어링·확장은 폰에 없다. */
const PHONE_STEPS: ReadonlySet<string> = new Set(["decide", "decideMember", "message", "complete", "handOff", "stop"]);

/** 가려진 입력을 끌어올린 뒤 키보드 윗변과 남기는 틈. */
const FIELD_GAP_PX = 8;
const TEXT_FIELD = "textarea, input:is(:not([type]), [type=text], [type=search], [type=email], [type=url], [type=tel], [type=number], [type=password])";

/**
 * 가상 키보드가 뷰포트를 줄여도 포커스한 입력이 화면 안에 남게 한다. WebView(adjustResize)는 높이만 줄이고 이 화면의
 * 내부 스크롤 칸(.objectives-m) 안의 입력은 끌어올리지 않는다(실기기: 결정 질문 2의 자유 입력이 키보드 아래 214.8px에 숨었다).
 * 포커스와 뷰포트 resize 때, 이미 보이는 입력은 그대로 두고 가려진 만큼만 이 칸을 스크롤한다(nearest). 셸·문서의 다른 스크롤
 * 조상은 건드리지 않는다. 시트(포털)의 입력은 이 칸 밖이라 대상이 아니다. 대화 정보 화면에 심긴 상세는 스스로 스크롤하지 않으므로
 * 그때 이 칸은 가장 가까운 스크롤 조상(정보 화면)이다.
 */
function useFocusedFieldInView(rootRef: { readonly current: HTMLDivElement | null }) {
  useEffect(() => {
    let frame = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = rootRef.current;
        const field = document.activeElement;
        // 키보드를 부르는 글 입력만 — 설정 토글(checkbox)처럼 키보드 없는 입력은 포커스돼도 움직이지 않는다.
        if (!root || !(field instanceof HTMLElement) || !field.matches(TEXT_FIELD) || !root.contains(field)) return;
        const scroller = scrollerOf(root);
        const viewport = window.visualViewport;
        const box = scroller.getBoundingClientRect();
        const top = Math.max(box.top, viewport?.offsetTop ?? 0);
        const bottom = Math.min(box.bottom, viewport ? viewport.offsetTop + viewport.height : window.innerHeight);
        const rect = field.getBoundingClientRect();
        if (rect.bottom > bottom) scroller.scrollTop += Math.min(rect.bottom - bottom + FIELD_GAP_PX, rect.top - top);
        else if (rect.top < top) scroller.scrollTop -= top - rect.top + FIELD_GAP_PX;
      });
    };
    document.addEventListener("focusin", settle);
    window.addEventListener("resize", settle);
    window.visualViewport?.addEventListener("resize", settle);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", settle);
      window.removeEventListener("resize", settle);
      window.visualViewport?.removeEventListener("resize", settle);
    };
  }, [rootRef]);
}

/** 입력을 끌어올릴 스크롤 칸 — 상세 자신(.objectives-m)이 스크롤하면 그것, 아니면 가장 가까운 스크롤 조상이다. */
function scrollerOf(root: HTMLElement): HTMLElement {
  for (let node: HTMLElement | null = root; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return root;
}

/** 대화 정보 화면의 「목표」 탭 본문 — 호스트가 `mobile.conversationPane` 으로 대화 주인 Operation 을 params 로 싣는다(막대 창구 없음). */
export function MobileConversationObjective({ ctx }: { readonly ctx: PaneContext }) {
  const operationId = ctx.params.operationId ?? "";
  const objective = useSyncExternalStore(subscribeObjective, () => objectiveOfOperation(operationId), () => objectiveOfOperation(operationId));
  return <MobileObjectiveDetail ctx={ctx} objectiveId={objective?.id ?? ""} />;
}

/**
 * 목표 상세 — 두 자리에 선다. 목표 화면(`MobileObjectiveScreen`)에서는 호스트 막대(`mobileBar`)에 제목·⋮ 동작을 선언하는 뿌리이고,
 * 대화 정보 화면의 「목표」 탭에서는 막대가 없어 같은 동작을 본문 맨 위 동작 줄로 그린다. 제목은 정보 화면 머리가 말하므로 본문에 다시 세우지 않는다.
 * 보관은 두 자리 모두 두지 않는다 — Operation 이 있는 목표의 보관은 대화 정보 화면 「정보」 탭의 Operation 보관이고, 기동 전 목표의 영구 삭제는 데스크톱만이다.
 */
export function MobileObjectiveDetail({ ctx, objectiveId }: { readonly ctx: PaneContext; readonly objectiveId: string }) {
  const t = getT(ctx.language, true);
  const language = ctx.language ?? "en";
  const objective = useObjective(objectiveId);
  const operations = operationIndex(useOperationSummaries());
  const { mobileBar, visible, api } = ctx;
  // 막대가 없으면 대화 정보 화면의 「목표」 탭에 심긴 것이다 — 동작은 본문 맨 위 동작 줄로 그린다.
  const embedded = !mobileBar;
  const title = objective?.title ?? t("objectives.panel.title");
  const [sheet, setSheet] = useState(false);
  const [routingSheet, setRoutingSheet] = useState(false);
  const [followupSheet, setFollowupSheet] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusedFieldInView(rootRef);
  const [toast, setToast] = useState<{ readonly text: string; readonly at: number } | null>(null);
  const say = useCallback((text: string) => setToast({ text, at: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  // 탭으로 착지한 목표의 reveal 은 이 자리가 집는다 — 남겨 두면 나중에 목표 화면이 열릴 때 엉뚱하게 이 목표를 세운다.
  const reveal = useReveal();
  useEffect(() => { if (embedded && reveal && reveal.objectiveId === objectiveId) takeReveal(); }, [embedded, reveal, objectiveId]);

  const launchAvailable = useSyncExternalStore(subscribeObjective, () => launchAvailableFor(objectiveId), () => launchAvailableFor(objectiveId));
  const actions = objective ? objectiveActions(objective, operations, t, launchAvailable) : null;
  const crew = useCrewActions(objective, operations, t, api, language, say);
  // 확인 시트는 누를 수 있는 개시 카드가 라우팅 확인을 요구하는 동안만 선다 — 그새 다른 곳에서 개시했거나 막혔으면 닫는다.
  const reviewing = actions?.commence && !actions.commence.reason && actions.commence.review.length > 0 ? actions.commence.review : null;
  const canReview = reviewing !== null;
  useEffect(() => { if (!canReview) setRoutingSheet(false); }, [canReview]);
  // 후속 시트는 볼 후보가 남아 있는 동안만 선다 — 그새 완료됐거나 모두 정리됐으면 닫는다.
  const followupCount = objective && !objective.done ? openFollowups(objective).length : 0;
  useEffect(() => { if (followupCount === 0) setFollowupSheet(false); }, [followupCount]);
  // 막대 선언은 내용이 바뀔 때만 다시 한다 — 매 렌더 선언하면 호스트 갱신과 맞물려 돈다. 동작은 ref 로 최신을 부른다.
  const latest = useRef({ actions, objectiveId, say, language, t });
  latest.current = { actions, objectiveId, say, language, t };
  const act = useCallback((path: string) => {
    const { objectiveId: id, say: speak, language: locale, t: translate } = latest.current;
    void post(api, path, { objectiveId: id, language: locale }).catch((error: unknown) => speak(bandFailure(translate, error, { message: false, talk: false })));
  }, [api]);
  // 사람 동작 — 막대의 ⋮ 항목과 심긴 자리의 동작 줄이 같은 목록이다. 누르는 순간의 판정은 ref 로 읽는다.
  const personActions = useCallback((current: ObjectiveActions | null): MobileBarMenuItem[] => {
    if (!current) return [];
    const items: MobileBarMenuItem[] = [];
    // 「메시지」는 늘 선다 — 받을 세션이 없거나 띠가 다른 할 일을 먼저 세우는 동안은 흐리게.
    items.push({ id: "message", label: t("objectives.message"), icon: <MessageIcon />, disabled: !current.message, run: () => setSheet(true) });
    // 후속 후보가 남아 있으면 띠처럼 곧바로 완료하지 않고 고르기 시트를 연다 — 누르는 순간의 판정을 쓴다.
    if (current.complete) items.push({ id: "complete", label: t("objectives.review.complete"), icon: <CheckIcon />, run: () => { if (latest.current.actions?.finish?.followups) setFollowupSheet(true); else act("/objective/complete"); } });
    if (current.handOff) items.push({ id: "handOff", label: t("objectives.handoff.send"), icon: <SendIcon />, run: () => act("/objective/hand-off") });
    // 중단은 다시 개시할 수 있어 파괴 동작이 아니다 — 일반 색.
    if (current.stop) items.push({ id: "stop", label: t("objectives.stop"), icon: <StopIcon />, run: () => act("/commander/stop") });
    return items;
  }, [act, t]);
  // 목표 화면의 상태 한 낱말(막대 보조 줄) — 시작 전 목표는 홈 행의 「시작 전」에서 이어지고, 보관된 끝난 목표는 읽기 전용임을 말한다.
  const fresh = !!objective && !objective.done && !objective.awaitingReview && !objective.commander.started && !operations.has(objective.id);
  const stateWord = !objective ? null : fresh ? t("objectives.state.fresh") : objective.done ? t("objectives.mobile.state.done") : null;
  // 시작 전 목표(Operation 없음)의 이름 변경·보관 — 폰에는 목록이 없으니 이 화면의 ⋮ 가 받는다. 보관은 복원할 수 있다(사이드바 줄의 「보관」과 같은 경로).
  const settingsHost = useMobileSettingsHost();
  const tidy = !embedded && !!objective && !objective.hasOperation && !objective.done;
  // 완료한 목표는 보관하지 않으므로 사람이 따로 보관할 길을 ⋮ 에 둔다 — 이름 변경은 서버가 완료 목표에 거절하므로 「보관」만. 이미 보관된(「끝남」에서 연) 목표는 뺀다.
  const archivable = tidy || (!embedded && !!objective?.done && !objective.archived);
  const rename = useCallback(() => {
    const current = findObjective(latest.current.objectiveId);
    if (!current || !settingsHost?.openInput) return;
    const { t: translate, say: speak } = latest.current;
    settingsHost.openInput({
      title: translate("objectives.mobile.rename"),
      value: current.title,
      onSave: async (value) => {
        const next = value.trim();
        if (!next || next === current.title) return;
        await post(api, "/objective/patch", { objectiveId: current.id, patch: { title: next } }).catch((error: unknown) => speak(bandFailure(translate, error, { message: false, talk: false })));
      },
    });
  }, [api, settingsHost]);
  const { rail } = ctx;
  const archive = useCallback(() => {
    const { objectiveId: id, say: speak, t: translate } = latest.current;
    void post<{ objective: Objective; deleted: boolean }>(api, "/objective/archive", { objectiveId: id, restorable: true })
      .then((result) => {
        if (result?.objective) upsertObjectiveLocally(result.objective);
        // 이 화면의 목표가 보관함으로 갔다 — 빈 화면을 남기지 않고 홈으로 돌아간다(폰 목적지 화면의 `rail.close`).
        rail.close("objectives");
      })
      .catch((error: unknown) => speak(bandFailure(translate, error, { message: false, talk: false })));
  }, [api, rail]);
  const menuKey = actions ? `${actions.message ? 1 : 0}${actions.complete ? 1 : 0}${actions.handOff ? 1 : 0}${actions.stop ? 1 : 0}${tidy ? 1 : 0}${archivable ? 1 : 0}` : "";
  useEffect(() => {
    if (!visible || !mobileBar) return;
    const items: MobileBarMenuItem[] = [
      ...personActions(latest.current.actions),
      ...(tidy && settingsHost?.openInput ? [{ id: "rename", label: t("objectives.mobile.rename"), icon: <PencilIcon />, run: rename }] : []),
      ...(archivable ? [{ id: "archive", label: t("objectives.objective.archive"), icon: <ArchiveIcon />, run: archive }] : []),
    ];
    // 누를 수 있는 항목이 하나도 없으면 ⋮ 를 세우지 않는다 — 흐린 「메시지」 하나만 여는 메뉴가 되지 않게.
    const usable = items.some((item) => !item.disabled);
    // 목표 화면의 뿌리다 — ‹ 는 홈으로 간다.
    mobileBar.set({ title, ...(stateWord ? { subtitle: stateWord } : {}), depth: 0, ...(usable ? { menu: { label: t("objectives.mobile.menuLabel"), caption: title, items } } : {}) });
  }, [mobileBar, visible, title, stateWord, menuKey, t, personActions, tidy, archivable, settingsHost, rename, archive]);

  // 탭 — 데스크톱 상세와 같은 세 낱말이고, 고른 탭도 같은 Theater 보기 상태에 남는다.
  const theaterId = objective?.theaterId ?? null;
  const tab = detailTabOf(useObjectiveView(theaterId).detailTab);
  const [dateAnchor, setDateAnchor] = useState<DOMRect | null>(null);
  const dueButton = useRef<HTMLButtonElement | null>(null);
  // 좁은 폭에서 탭 바가 넘치면 고른 탭이 보이게 가로로만 당긴다.
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [tab]);
  const rootClass = embedded ? "objectives-m is-embedded" : "objectives-m";
  // 단독 목표 화면은 호스트 상단 막대 뒤로 흐른다 — 탭 줄이 막대 몫(--m-chrome-top)을 품고 떠 있는 줄이 된다(mobile.css). 정보 화면에 심긴
  // 상세는 그 화면의 스크롤이 막대 몫을 맡는다.
  const flow = embedded ? {} : { "data-mobile-chrome": "flow" };
  if (!objective || !actions) return <div ref={rootRef} className={rootClass} {...flow} />;
  const locale = language === "ko" ? "ko" : "en";
  const editable = !objective.done && !WORKING.has(activityOf(operations, objective.id));
  const patch = (value: Record<string, unknown>) => { void post(api, "/objective/patch", { objectiveId: objective.id, patch: value, language }).catch((error: unknown) => say(bandFailure(t, error, { message: false, talk: false }))); };
  const overdue = !!objective.dueDate && objective.dueDate < todayIso() && !objective.done;
  const todayLabel = t(objective.today ? "objectives.schedule.removeToday" : "objectives.schedule.addToday");
  const dueText = objective.dueDate ? t("objectives.tabs.dueTip", { date: dueLabel(objective.dueDate, locale) }) : t("objectives.schedule.setDue");
  const pickTab = (next: DetailTab) => patchObjectiveView(theaterId, () => ({ detailTab: next }));
  // 대화 정보 화면은 호스트의 한 줄 탭을 쓴다. Operation 없는 단독 목표 화면만 자기 탭을 가진다.
  const tabBar = !embedded ? (
    <div className="objectives-m-tabbar">
      <div ref={tabsRef} className="objectives-m-tabs" role="tablist" aria-label={t("objectives.tabs.aria")}>
        {DETAIL_TABS.map((key) => (
          <button key={key} type="button" role="tab" aria-selected={key === tab} onClick={() => pickTab(key)}>
            {t(`objectives.tabs.${key}`)}{key === "goal" && objective.decisionRequest && !objective.done ? <span className="objectives-m-tdot" role="img" aria-label={t("objectives.tabs.decisionDot")} /> : null}
          </button>
        ))}
      </div>
    </div>
  ) : null;
  const schedule = (
    <div className="objectives-m-schedule" role="group" aria-label={t("objectives.schedule.title")}>
      <button type="button" className={objective.today ? "is-on" : undefined} aria-pressed={objective.today} aria-label={todayLabel} disabled={!editable} onClick={() => patch({ today: !objective.today })}>
        <SunGlyph /><span>{t(objective.today ? "objectives.mobile.today" : "objectives.mobile.addToday")}</span>
      </button>
      <button ref={dueButton} type="button" className={`${objective.dueDate ? "is-on" : ""}${overdue ? " is-overdue" : ""}`} aria-label={dueText} disabled={!editable} aria-haspopup="dialog" aria-expanded={!!dateAnchor} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setDateAnchor((value) => (value ? null : rect)); }}>
        <CalGlyph /><span>{objective.dueDate ? t(overdue ? "objectives.mobile.overdueDate" : "objectives.mobile.dueDate", { date: dueShort(objective.dueDate, locale) }) : t("objectives.mobile.setDue")}</span>
      </button>
      {dateAnchor ? <DatePicker anchor={dateAnchor} trigger={dueButton} value={objective.dueDate} language={locale} t={t} onPick={(next) => patch({ dueDate: next })} onClose={() => setDateAnchor(null)} /> : null}
    </div>
  );
  // 동작 줄도 같다 — 모두 흐리면 줄을 세우지 않아 첫 시선이 누를 수 없는 단추에 가지 않게 한다.
  const embeddedActions = embedded ? personActions(actions) : [];
  const rowActions = embeddedActions.some((item) => !item.disabled) ? embeddedActions : [];
  return (
    <div ref={rootRef} className={rootClass} {...flow}>
      {tabBar}
      <div className="objectives-m-pad">
        {tab === "goal" ? schedule : null}
        {rowActions.length > 0 ? (
          <div className="objectives-m-acts" role="group" aria-label={t("objectives.mobile.menuLabel")}>
            {rowActions.map((item) => (
              <button type="button" key={item.id} data-press="r3" className="objectives-m-act" disabled={item.disabled} onClick={item.run}>
                {item.icon}<span>{item.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        {/* 폰에는 완료 검토·후속 고르기 칸이 따로 없다 — 사령관이 넘긴 것이면 그 이유·돌려주기와 함께 그 자리에서 답하는 카드로 세운다.
            지금 할 일(결정 요청 답하기·넘김 답하기·개시 카드)은 탭과 무관하게 탭 칸 맨 위에 선다. 결정 내역은 목표 탭 맨 아래다. */}
        <DecisionSection objective={objective} operations={operations} t={t} language={language} api={api} say={say} />
        <HoldAnswers objective={objective} finish={actions.finish} t={t} language={language} api={api} onPick={() => setFollowupSheet(true)} onShowLeftover={() => { pickTab("results"); revealFollowupResults(); }} />
        {actions.commence ? <CommenceCard objective={objective} commence={actions.commence} t={t} language={language} api={api} say={say} onReview={() => setRoutingSheet(true)} /> : null}
        {tab === "goal" ? <>
          <BriefCard objective={objective} t={t} />
          <ProposalsCard objective={objective} t={t} language={language} api={api} say={say} />
          <DecisionHistory objective={objective} t={t} />
        </> : tab === "crew" ? <>
          <CrewSection objective={objective} operations={operations} t={t} crew={crew} />
          <SubagentsSection objective={objective} t={t} crew={crew} />
          {/* 임무 — 구성원 탭 맨 아래. 폰은 그래프 대신 글 목록이다 — 머리는 맡은 사람(구성원이 없으면 지휘관), 끝남은 줄 끝의 체크가 말한다. */}
          {objective.missions.length > 0 ? <>
            <h2 className="objectives-m-glab">{t("objectives.missions.title")}</h2>
            <div className="objectives-m-grp">
              {objective.missions.map((mission) => {
                const member = mission.member ? objective.members.find((candidate) => candidate.id === mission.member) : undefined;
                return (
                  <div key={mission.id} className={`objectives-m-row is-mission${mission.done ? " is-done" : ""}`}>
                    {member ? <MemberMark objective={objective} member={member} operations={operations} /> : <CommanderMark objective={objective} operations={operations} />}
                    <span className="objectives-m-tx">{mission.text}</span>
                    {mission.done ? <span className="objectives-m-mission-done"><CheckIcon size={18} /></span> : null}
                  </div>
                );
              })}
            </div>
          </> : null}
        </> : <>
          <ResultsSection objective={objective} t={t} language={language} openLink={ctx.openLink ?? null} />
          <FollowupResults objective={objective} t={t} language={language} api={api} say={say} />
          <RetroCard objective={objective} t={t} />
        </>}
      </div>
      {routingSheet && reviewing ? <RoutingSheet objective={objective} targets={reviewing} t={t} api={api} language={language} say={say} onClose={() => setRoutingSheet(false)} /> : null}
      {followupSheet && followupCount > 0 ? <FollowupSheet objective={objective} finish={actions.finish} t={t} api={api} language={language} onClose={() => setFollowupSheet(false)} /> : null}
      {sheet ? <MessageSheet t={t} objectiveId={objective.id} recipients={actions.recipients} api={api} language={language} say={say} onClose={() => setSheet(false)} /> : null}
      {toast ? createPortal(<div key={toast.at} className="objectives-m-toast" role="status">{toast.text}</div>, document.body) : null}
    </div>
  );
}

// ── 넘김 답하기 ──

/** 막힌 사정을 누르기 전의 상태로 말한다 — 개시 카드와 같은 상태 문구를 먼저 쓰고, 띠의 거절 문구는 쓰지 않는다. */
function finishBlockText(t: T, objective: Objective, block: FinishBlock): string {
  switch (block) {
    case "working": return t("objectives.mobile.commence.working");
    case "awaiting": return t("objectives.mobile.finish.awaiting");
    case "gated": return t("objectives.band.gated", { count: objective.criteriaProposals.length });
    case "steer": return t("objectives.band.reason.steerRequired");
    case "notInReview": return t("objectives.band.reason.notInReview");
  }
}

/**
 * 후속 후보를 지금 고를 수 있는지의 한 줄 — 띠가 다른 할 일을 먼저 세우면 그 상태로, 고를 수 없으면 데스크톱 넘김 카드와 같은 판정
 * (`followupHoldRoute`: 완료 뒤 남은 후보·스티어링·기준 잠금·인계 대기·검토 대기에서 고르기)으로 말한다.
 */
function followupNote(objective: Objective, finish: ObjectiveActions["finish"], t: T, count: number): string {
  if (finish?.followups) return t("objectives.followup.listTip", { n: count });
  if (isFollowupSelectable(objective)) return finishBlockText(t, objective, finish?.blocked ?? "notInReview");
  return t(followupHoldRoute(objective), { n: count });
}

/**
 * 사령관이 넘긴 완료 검토·후속 후보 — 이유·돌려주기(`PersonHoldNote`) 카드에 그 항목에 직접 답하는 단추를 붙인다.
 * 「완료」는 데스크톱 띠와 같은 `/objective/complete` 이고, 후속 후보가 남아 있으면 띠처럼 곧바로 완료하지 않고 고르기 시트를 연다.
 * 띠가 지금 완료를 세우지 못하면(작업 중·허용 대기·기준 제안·스티어링) 단추를 흐리게 두고 막힌 상태를 말한다.
 * 둘이 함께 서면 두 카드가 같은 시트를 연다 — 넘김은 따로 돌려줄 수 있어, 하나를 돌려준 뒤에도 남은 카드만으로 답이 된다.
 * 후속 카드는 고를 수 없는 동안에도 시트를 열어 후보를 읽고 폐기할 수 있다. 완료 뒤에는 고르기 시트가 없으므로 결과물 탭의 남긴 후보로 잇는다.
 */
function HoldAnswers({ objective, finish, t, language, api, onPick, onShowLeftover }: {
  readonly objective: Objective;
  readonly finish: ObjectiveActions["finish"];
  readonly t: T;
  readonly language: ConsoleLocale;
  readonly api: PaneContext["api"];
  readonly onPick: () => void;
  readonly onShowLeftover: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => { setFault(null); }, [objective.id, finish?.blocked, finish?.followups]);
  const reviewHeld = livePersonHold(objective, "review") !== null;
  const followupHeld = livePersonHold(objective, "followup") !== null;
  if (!reviewHeld && !followupHeld) return null;
  const count = openFollowups(objective).length;
  const blocked = finish?.blocked ?? "notInReview";
  const completable = !!finish && finish.blocked === null;
  const pickable = !!finish?.followups;
  const complete = () => {
    if (busy || !completable) return;
    if (pickable) { onPick(); return; }
    setBusy(true);
    setFault(null);
    void post(api, "/objective/complete", { objectiveId: objective.id, language })
      .catch((error: unknown) => setFault(bandFailure(t, error, { message: false, talk: false })))
      .finally(() => setBusy(false));
  };
  const reviewDesc = !completable ? finishBlockText(t, objective, blocked)
    : pickable ? t("objectives.followup.sub", { n: count })
      : t(objective.criteria.length > 0 ? "objectives.review.subCriteria" : "objectives.review.sub");
  return (
    <>
      {reviewHeld ? (
        <PersonHoldNote objective={objective} target="review" t={t} phone label={t("objectives.objectives.review")} locked={busy}
          answer={<button type="button" data-press="r3" className="objectives-m-b2" disabled={busy || !completable} aria-busy={busy || undefined} onClick={complete}>{t(busy ? "objectives.band.sending" : "objectives.review.complete")}</button>}>
          <p className="objectives-m-prop-sub">{reviewDesc}</p>
          {fault ? <p className="objectives-m-fault" role="status">{fault}</p> : null}
        </PersonHoldNote>
      ) : null}
      {followupHeld ? (
        <PersonHoldNote objective={objective} target="followup" t={t} phone label={t("objectives.followup.title")} locked={busy}
          answer={<button type="button" data-press="r3" className="objectives-m-b2" disabled={busy} onClick={objective.done ? onShowLeftover : onPick}>{pickable ? t("objectives.mobile.followup.pick") : t("objectives.followup.openTip", { n: count })}</button>}>
          <p className="objectives-m-prop-sub">{followupNote(objective, finish, t, count)}</p>
        </PersonHoldNote>
      ) : null}
    </>
  );
}

/**
 * 후속 후보 고르기 시트 — 데스크톱 띠의 후속 칸과 같은 줄·상세(`FollowupCandidateList`)와 같은 선택 초안(`useFollowupSelection`, 탭 메모리)이다.
 * 고를 수 있으면 바닥 「완료」가 선택 순간의 rev 로 `/objective/complete` 에 한 번 보낸다 — 고른 게 없으면 그대로 완료다. 그새 바뀐 후보는
 * 서버가 followup_changed 로 거절하고, 시트는 열린 채 띠와 같은 사유를 말한다(바뀐 후보의 선택은 풀려 다시 읽고 고른다).
 * 고를 수 없는 상태면 읽기·폐기만 하고 막힌 사정을 말한다.
 */
function FollowupSheet({ objective, finish, t, api, language, onClose }: {
  readonly objective: Objective;
  readonly finish: ObjectiveActions["finish"];
  readonly t: T;
  readonly api: PaneContext["api"];
  readonly language: ConsoleLocale;
  readonly onClose: () => void;
}) {
  const sheet = useBottomSheet(onClose);
  const objectiveId = objective.id;
  const candidates = openFollowups(objective);
  const selectable = !!finish?.followups;
  const selection = useFollowupSelection(objectiveId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 고른 후보가 고쳐져 선택이 풀렸다 — 사람이 모르고 0건으로 완료하지 않게, 다시 고르거나 닫을 때까지 시트에 한 줄 남긴다.
  const [revised, setRevised] = useState(false);
  // 이 시트가 마지막으로 본 선택(id → 고른 순간의 rev) — 다른 곳에서 먼저 풀어도 무엇이 풀렸는지 안다.
  const seenRevs = useRef(new Map(readSelectionRevs(objectiveId)));
  const idsKey = candidates.map((candidate) => `${candidate.id}:${candidate.rev}`).join(",");
  // 띠와 같다 — 목록에서 사라진 id 는 초안에서 거두고, rev 가 바뀐 id 는 선택을 풀어 고친 본문을 확인한 뒤 다시 고르게 한다.
  useEffect(() => {
    const openRevs = new Map(idsKey ? idsKey.split(",").map((entry) => { const at = entry.lastIndexOf(":"); return [entry.slice(0, at), Number(entry.slice(at + 1))] as const; }) : []);
    const changed = [...seenRevs.current].some(([id, rev]) => openRevs.has(id) && openRevs.get(id) !== rev);
    pruneSelection(objectiveId, openRevs);
    seenRevs.current = new Map(readSelectionRevs(objectiveId));
    if (changed) setRevised(true);
  }, [objectiveId, idsKey]);
  // 선택이 바뀌면 본 선택도 따라간다 — 위 효과가 먼저 돌아 같은 커밋의 rev 변경을 놓치지 않는다.
  useEffect(() => { seenRevs.current = new Map(readSelectionRevs(objectiveId)); }, [objectiveId, selection]);
  const total = candidates.length;
  const picked = candidates.filter((candidate) => selection.has(candidate.id)).length;
  const submit = async () => {
    if (sending || !selectable) return;
    const live = new Set(candidates.map((candidate) => candidate.id));
    const chosen = [...readSelectionRevs(objectiveId)].filter(([id]) => live.has(id));
    setSending(true);
    setError(null);
    try {
      await post(api, "/objective/complete", chosen.length === 0
        ? { objectiveId, language }
        : { objectiveId, batchId: newBatchId(), followups: chosen.map(([id, rev]) => ({ id, rev })), language });
      clearSelection(objectiveId);
      sheet.close();
    } catch (failure) {
      setError(bandFailure(t, failure, { message: false, talk: false }));
    } finally { setSending(false); }
  };
  const discard = (candidateId: string) => {
    setError(null);
    void post(api, "/followup/discard", { objectiveId, candidateId, language }).catch((failure: unknown) => setError(bandFailure(t, failure, { message: false, talk: false })));
  };
  return (
    <BottomSheet sheet={sheet} t={t} title={t("objectives.followup.title")} busy={sending} focusOnOpen
      foot={selectable ? (
        <button type="button" data-press="r3" className="objectives-m-pill2 is-inv" disabled={sending} aria-busy={sending || undefined} onClick={() => void submit()}>
          {t(sending ? "objectives.band.sending" : "objectives.review.complete")}
        </button>
      ) : null}>
      <p className="objectives-m-secnote" aria-live="polite">{selectable ? `${t("objectives.followup.pick")} · ${t("objectives.followup.count", { k: picked, n: total })}` : followupNote(objective, finish, t, total)}</p>
      <div className="objectives-m-followups">
        <FollowupCandidateList
          candidates={candidates}
          selectable={selectable}
          selection={selection}
          t={t}
          idPrefix={`m-${objectiveId}`}
          openId={openId}
          onOpenChange={setOpenId}
          onToggleCheck={(candidateId, checked) => { const rev = candidates.find((candidate) => candidate.id === candidateId)?.rev ?? 1; toggleFollowupSelection(objectiveId, candidateId, checked, rev); setError(null); setRevised(false); }}
          onDiscard={discard}
        />
        <FollowupDiscardedTrace discarded={discardedFollowups(objective)} t={t} />
      </div>
      {revised && !error ? <p className="objectives-m-fault" role="status">{t("objectives.band.reason.followupChanged")}</p> : null}
      {error ? <p className="objectives-m-fault" role="alert">{error}</p>
        : selectable ? <p className="objectives-m-secnote">{picked === 0 ? t("objectives.followup.sendEmpty", { n: total }) : t("objectives.followup.sendSome", { k: picked })}</p>
        : null}
    </BottomSheet>
  );
}

// ── 개시 ──

/** 목표가 속한 Theater 의 호스트가 Operation 을 띄울 수 있는가 — 데스크톱 띠의 launchAvailable 과 같은 값. */
const launchAvailableFor = (objectiveId: string): boolean =>
  readAllTheaters().find((state) => state.objectives.some((objective) => objective.id === objectiveId))?.launchAvailable ?? false;

/**
 * 개시 카드 — 누름 한 번으로 데스크톱 입력창의 「개시」와 같은 `/commander/start` 를 보낸다(덧붙일 말 없이). 막혔으면 단추를 흐리게 두고
 * 그 아래에 이유를 말한다. 보낸 요청이 돌아올 때까지 단추를 잠가 두 번 보내지 않는다. 실패 문구는 띠와 같은 `bandFailure` 다.
 * 라우팅 확인이 걸리면(review) 여기서는 보내지 않고 확인 시트를 연다 — 확인 없이 라우팅 구성원을 띄우는 길을 남기지 않는다.
 */
function CommenceCard({ objective, commence, t, language, api, say, onReview }: { readonly objective: Objective; readonly commence: NonNullable<ObjectiveActions["commence"]>; readonly t: T; readonly language: ConsoleLocale; readonly api: PaneContext["api"]; readonly say: (text: string) => void; readonly onReview: () => void }) {
  const [busy, setBusy] = useState(false);
  const members = objective.members.length;
  const routed = commence.review.length ? t("objectives.start.routeConfirm", { count: commence.review.length }) : "";
  const desc = commence.reason ?? (commence.kind === "resume" ? `${t("objectives.start.resume")}${routed}`
    : members ? `${t("objectives.start.members", { count: members })}${routed}` : objective.missions.length ? t("objectives.start.direct") : t("objectives.band.start.bare"));
  const start = () => {
    if (busy || commence.reason) return;
    if (commence.review.length > 0) { onReview(); return; }
    setBusy(true);
    void post<{ failed?: readonly { role: string }[] }>(api, "/commander/start", { objectiveId: objective.id, language })
      .then((result) => {
        const failed = result?.failed ?? [];
        if (failed.length) say(t("objectives.start.failedMembers", { count: failed.length, roles: failed.map((entry) => entry.role).join(", ") }));
      })
      .catch((error: unknown) => say(bandFailure(t, error, { message: false, talk: false })))
      .finally(() => setBusy(false));
  };
  return (
    <section className="objectives-m-card" aria-label={t("objectives.commander.start")}>
      <h3 className="objectives-m-card-label">{t("objectives.commander.title")}</h3>
      <p className="objectives-m-prop-sub">{desc}</p>
      {/* 막힌 동안은 단추 없이 사유만 — 누를 수 없는 넓은 막대가 다음 걸음처럼 서지 않게 한다. */}
      {commence.reason ? null : (
        <button type="button" data-press="r3" className={`objectives-m-pbtn${commence.primary ? " is-approve" : ""} objectives-m-approve-all`} disabled={busy} aria-busy={busy || undefined} onClick={start}>
          {t("objectives.commander.start")}
        </button>
      )}
    </section>
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

const FOLLOWUP_RESULTS_ID = "objectives-m-followup-results";
/** 넘김 카드에서 결과물 탭으로 건너온 뒤, 탭이 그려지면 후속 목표 묶음을 화면에 들인다. */
function revealFollowupResults(): void {
  requestAnimationFrame(() => document.getElementById(FOLLOWUP_RESULTS_ID)?.scrollIntoView({ block: "start" }));
}

/**
 * 후속 목표 — 데스크톱 결과물 탭의 「후속 목표」 묶음과 같은 내용이다. 진행 중에는 모인 후보를 읽기만 하고(고르기·폐기는
 * 검토 대기의 시트), 완료 뒤에는 고른 후보의 생성 결과(다시 시도)와 남긴 후보를 보인다. 폰은 접지 않고 펼쳐 둔다.
 */
function FollowupResults({ objective, t, language, api, say }: { readonly objective: Objective; readonly t: T; readonly language: ConsoleLocale; readonly api: PaneContext["api"]; readonly say: (text: string) => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openFollowups(objective);
  const batches = readBatches(objective);
  const history = readHistory(objective);
  if (batches.length === 0 && !history && open.length === 0) return null;
  const collected = objective.done ? [] : open;
  return (
    <section id={FOLLOWUP_RESULTS_ID} className="objectives-m-followup-results" aria-label={t("objectives.followup.results")}>
      <h2 className="objectives-m-glab">{t("objectives.followup.results")}</h2>
      {collected.length ? <>
        <p className="objectives-m-secnote">{t("objectives.followup.collected", { n: collected.length })}</p>
        <div className="objectives-m-followups">
          <FollowupCandidateList
            candidates={collected}
            selectable={false}
            selection={NO_SELECTION}
            t={t}
            idPrefix={`m-res-${objective.id}`}
            openId={openId}
            onOpenChange={setOpenId}
            onToggleCheck={() => {}}
          />
        </div>
      </> : null}
      <FollowupBatchResults
        batches={batches}
        leftover={objective.done ? open : []}
        historyTotal={history}
        language={language === "ko" ? "ko" : "en"}
        t={t}
        onRetry={(batchId, candidateId) => { void post(api, "/followup/retry", { objectiveId: objective.id, batchId, candidateId, language }).catch((error: unknown) => say(bandFailure(t, error, { message: false, talk: false }))); }}
        onOpenObjective={(operationId) => openObjectiveOnPhone(operationId, objective.theaterId)}
      />
    </section>
  );
}
const NO_SELECTION: ReadonlySet<string> = new Set();

/** 회고 — 데스크톱 결과물 탭의 접힌 묶음과 같다. 인계 기록이 있을 때만 서고, 접힌 채 「더 보기」로 편다. 내용은 데스크톱 회고와 같은 구성요소다. */
function RetroCard({ objective, t }: { readonly objective: Objective; readonly t: T }) {
  const [open, setOpen] = useState(false);
  const handoff = objective.handoff;
  if (!handoff) return null;
  return (
    <section className="objectives-m-card objectives-m-retro" aria-label={t("objectives.retro.title")}>
      <h3 className="objectives-m-card-label">{t("objectives.retro.title")}</h3>
      {open ? <Retrospective
        t={t}
        by={handoff.by}
        good={handoff.retrospective?.wentWell.map((pair) => ({ text: pair.point, aside: pair.because })) ?? []}
        regret={handoff.retrospective?.fellShort.map((pair) => ({ text: pair.point, aside: pair.ifOnly })) ?? []}
      /> : null}
      <button type="button" data-press="r1" className="objectives-m-more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{t(open ? "objectives.mobile.brief.less" : "objectives.mobile.brief.more")}</button>
    </section>
  );
}

// ── 지휘관·구성원 ──

const COMMANDER_LIVE = new Set(["idle", "running", "awaiting"]);

/** 거절 코드 → 토스트 한 줄. 라우팅·전환 사유는 사람의 말로, 지휘관이 일하는 중이면 그 사정으로. */
const launchFailure = (t: T, error: unknown): string => {
  const code = error instanceof Error ? error.message : "unknown";
  return code === "objective_busy" ? t("objectives.toast.busy") : hasRoutingReason(code) ? routingReason(t, code) : t("objectives.toast.failed", { code });
};

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
  const commanderWord = memberActivityWord(commanderState, t);
  const patchMember = (member: ObjectiveMember, launch: MemberLaunchChoice | null) => { crew.send("/member/patch", { memberId: member.id, patch: { launch } }).catch(crew.fail); };
  return (
    <SettingsCard title={t("objectives.mobile.crew")}>
      <SettingsRow label={t("objectives.commander.title")} icon={<CommanderMark objective={objective} operations={operations} />}
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
        const badge = memberStatus(member, state, objective, t);
        const session = member.sessionName !== null;
        const title = session ? operations.get(member.id)?.title ?? member.sessionName ?? undefined : undefined;
        return (
          <SettingsRow key={member.id} label={member.role} icon={<MemberMark objective={objective} member={member} operations={operations} />}
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
      <PersonHoldNote objective={objective} target="criteria" t={t} phone />
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

/** 목표 탭 맨 아래의 결정 내역 — 사람이 보낸 답이 질문마다, 최근 것이 위. 보낸 답 카드와 같은 문법(질문 → 답)이다. 답이 없으면 서지 않는다. */
function DecisionHistory({ objective, t }: { readonly objective: Objective; readonly t: T }) {
  if (objective.decisions.length === 0) return null;
  return (
    <>
      <h2 className="objectives-m-glab">{t("objectives.decisions.title")}</h2>
      <section className="objectives-m-ucard">
        {[...objective.decisions].reverse().map((decision) => (
          <p key={decision.id} className="objectives-m-ucard-p"><LinkText text={decision.question.text} /><br /><span className="objectives-m-answer">→ {answerText(decision)}</span></p>
        ))}
      </section>
    </>
  );
}

function DecisionSection({ objective, operations, t, language, api, say }: { readonly objective: Objective; readonly operations: OperationIndex; readonly t: T; readonly language: ConsoleLocale; readonly api: PaneContext["api"]; readonly say: (text: string) => void }) {
  const request = objective.done ? null : objective.decisionRequest;
  const [draftMap, setDraftMap] = useState(() => storedDrafts(objective.id, request?.id));
  const [sending, setSending] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [, setSentTick] = useState(0);
  // 자율 운영이 실제로 돌면 사령관이 이 요청에 답한다 — 데스크톱 결정 카드 머리 메모와 같은 판정(`decisionTurn`). 폰에는 툴팁이 없어 설명을 줄로 보인다.
  // 사람이 운영하는 목표의 요청과 사령관이 사람에게 넘긴 요청으로는 사령관이 답하지 않는다.
  const commodore = useCommodoreBoard(objective.theaterId);
  const answering = decisionTurn(objective, commodore.active) === "commodore";
  const handed = request ? livePersonHold(objective, "decision") : null;
  const [givingBack, setGivingBack] = useState(false);
  const idBase = useId();
  useEffect(() => { setDraftMap(storedDrafts(objective.id, request?.id)); setFault(null); }, [objective.id, request?.id]);

  if (!request) {
    const sentId = sentRequests.get(objective.id);
    const sent = sentId ? objective.decisions.filter((decision) => decision.requestId === sentId) : [];
    if (sent.length === 0) return null;
    return (
      <>
        <h2 className="objectives-m-glab">{t("objectives.decision.request")}</h2>
        <section className="objectives-m-ucard">
          <div className="objectives-m-ucard-hd"><CommanderMark objective={objective} operations={operations} />{t("objectives.mobile.decision.sent")}</div>
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
  // 사령관에게 돌려주기 — 성공하면 넘김이 걷혀 「사령관이 답하는 중」으로 돌아간다. 실패는 카드 끝 한 줄로.
  const giveBack = async () => {
    if (sending || givingBack) return;
    setGivingBack(true);
    setFault(null);
    try { await returnPersonHold(objective.id, "decision"); say(t("objectives.decision.givenBack")); }
    catch { setFault(t("objectives.decision.giveBackFailed")); }
    finally { setGivingBack(false); }
  };
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
              <div className="objectives-m-ucard-hd"><CommanderMark objective={objective} operations={operations} />{head}{index === 0 && answering ? <span className="objectives-m-ucard-handler">{t("objectives.commodore.note.answering")}</span> : null}</div>
              {index === 0 && answering ? <p className="objectives-m-fine">{t("objectives.commodore.decisionHint")}</p> : null}
              {index === 0 && handed ? <p className="objectives-m-handed"><b>{t("objectives.decision.handed")}</b><LinkText text={handed.reason} /></p> : null}
              {question.header ? <span className="objectives-m-qchip">{question.header}</span> : null}
              <p className="objectives-m-ucard-p is-question"><LinkText text={question.text} /></p>
              {hasOptions && question.multiSelect ? <p className="objectives-m-hint">{t("objectives.decision.multiHint")}</p> : null}
              {hasOptions ? (
                <div role={question.multiSelect ? "group" : "radiogroup"} aria-label={t("objectives.decision.optionsAria", { n: index + 1 })}>
                  {question.options.map((option) => {
                    const on = !draft.own && draft.picked.includes(option.id);
                    const subId = `${idBase}-${question.id}-${option.id}`;
                    // 설명은 단추 밖에 선다 — 그 안의 링크가 단추 속 앵커가 되지 않는다. 고르는 자리와 누름 면은 줄 전체다: 단추(이름)의
                    // 탭·Enter·Space 도 줄로 올라와 한 번 고르고, 설명의 링크 탭은 고르지 않고 링크만 연다.
                    const onRow = (event: ReactMouseEvent<HTMLDivElement>) => {
                      if (sending || (event.target as Element).closest("a")) return;
                      pick(question, option.id);
                    };
                    return (
                      <div key={option.id} className="objectives-m-opt-row" data-press={sending ? undefined : "r1"} onClick={onRow}>
                        <button type="button" role={question.multiSelect ? "checkbox" : "radio"} aria-checked={on} aria-describedby={option.description ? subId : undefined} disabled={sending} className="objectives-m-opt">
                          <span className={`${indicator}${on ? " is-on" : ""}`} aria-hidden="true">{question.multiSelect && on ? <CheckIcon size={14} /> : null}</span>
                          <span className="objectives-m-opt-tx">{option.label}</span>
                        </button>
                        {option.description ? <small id={subId} className="objectives-m-opt-sub"><LinkText text={option.description} /></small> : null}
                      </div>
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
                  maxLength={MAX_DECISION_ANSWER_INPUT}
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
                  <span className="objectives-m-fine objectives-m-route">{t(handed ? "objectives.decision.routeHanded" : "objectives.decision.route")}</span>
                  <span className="objectives-m-sp" />
                  {handed ? <button type="button" data-press="r3" className="objectives-m-b2 is-quiet" disabled={sending || givingBack} onClick={() => void giveBack()}>{t("objectives.decision.giveBack")}</button> : null}
                  <button type="button" data-press="r3" className="objectives-m-b2" disabled={sending || givingBack || doneCount !== total} onClick={() => void submit()}>
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

// ── 하단 시트 ──

interface SheetControl {
  readonly close: () => void;
  readonly closing: boolean;
  readonly drag: number;
  readonly handle: {
    readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
    readonly onPointerUp: () => void;
    readonly onPointerCancel: () => void;
  };
}

/** 하단 시트의 닫기 — ×·스크림·Escape·손잡이 끌어내리기가 모두 닫는 몸짓을 거친 뒤 onClose 를 부른다. */
function useBottomSheet(onClose: () => void): SheetControl {
  const [closing, setClosing] = useState(false);
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<{ readonly y: number; readonly moved: boolean } | null>(null);
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
  // 손잡이에서 끌어내리기 — 6 넘게 움직이면 따라오고, 110 넘게 끌고 놓으면 닫는다.
  const onPointerUp = () => {
    const moved = dragStart.current?.moved === true;
    dragStart.current = null;
    if (moved && drag > SHEET_DISMISS_PX) close();
    else setDrag(0);
  };
  return {
    close,
    closing,
    drag,
    handle: {
      onPointerDown: (event) => { event.currentTarget.setPointerCapture(event.pointerId); dragStart.current = { y: event.clientY, moved: false }; },
      onPointerMove: (event) => {
        const start = dragStart.current;
        if (!start) return;
        const dy = event.clientY - start.y;
        if (!start.moved && Math.abs(dy) < SHEET_DRAG_SLOP_PX) return;
        dragStart.current = { ...start, moved: true };
        setDrag(Math.max(0, dy));
      },
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}

/**
 * 하단 시트 틀 — 스크림 + 손잡이 + 제목·× + 본문(스크롤) + 바닥 단추 줄. focusOnOpen 이면 열릴 때 포커스를 대화상자로 옮긴다 —
 * 키보드·보조기기로 연 사람의 포커스가 배경에 남지 않게. 입력칸에 직접 포커스를 주는 시트(메시지)는 넘기지 않는다.
 */
function BottomSheet({ sheet, t, title, busy, focusOnOpen, children, foot }: { readonly sheet: SheetControl; readonly t: T; readonly title: string; readonly busy?: boolean; readonly focusOnOpen?: boolean; readonly children: ReactNode; readonly foot: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusOnOpen) dialogRef.current?.focus({ preventScroll: true }); }, [focusOnOpen]);
  return createPortal(
    <div className={`objectives-m-sheet-layer${sheet.closing ? " is-closing" : ""}`}>
      <div className="objectives-m-scrim" onClick={sheet.close} />
      <div ref={dialogRef} tabIndex={focusOnOpen ? -1 : undefined} className={`objectives-m-sheet${sheet.drag > 0 ? " is-dragging" : ""}`} role="dialog" aria-modal="true" aria-label={title} aria-busy={busy || undefined} style={sheet.drag > 0 ? { transform: `translateY(${sheet.drag}px)` } : undefined}>
        <div className="objectives-m-sheet-handle" {...sheet.handle}><i /></div>
        <div className="objectives-m-sheet-head">
          <h2>{title}</h2>
          <button type="button" data-press="r1" className="objectives-m-sheet-x" aria-label={t("objectives.detail.close")} onClick={sheet.close}><CloseIcon /></button>
        </div>
        <div className="objectives-m-sheet-body">{children}</div>
        <div className="objectives-m-sheet-ft">{foot}</div>
      </div>
    </div>,
    document.body,
  );
}

// ── 라우팅 확인 시트 ──

/** 판단 중(judging)·결과(ready). preview 가 없는 ready 는 판단을 받지 못했다(error). */
interface RoutingReview {
  readonly phase: "judging" | "ready";
  readonly preview: RoutingPreview | null;
  readonly error: { readonly stage: "preview" | "start"; readonly code: string } | null;
}

/**
 * 라우팅 확인 시트 — 데스크톱 띠의 확인 시트에서 최소 경로만 옮겼다. 열면 `/routing/preview` 로 판단(또는 10분 안의 같은 결과)을
 * 받아 라우팅 구성원마다 역할·모델·강도를 보이고, 폴백이면 사유를 말한다. 「개시」는 결과를 받은 뒤에만 `routing: "preview"` 로 보낸다 —
 * 서버는 본 결과가 없거나 낡았으면 `routing_preview_stale` 로 거절하고, 그때 시트는 결과를 다시 받아 사정을 말한다.
 * 행별 모델 바꾸기·다시 판단(과금)·확인 끄기는 데스크톱에만 둔다.
 */
function RoutingSheet({ objective, targets, t, api, language, say, onClose }: {
  readonly objective: Objective;
  readonly targets: readonly ObjectiveMember[];
  readonly t: T;
  readonly api: PaneContext["api"];
  readonly language: ConsoleLocale;
  readonly say: (text: string) => void;
  readonly onClose: () => void;
}) {
  const rows = useLaunchRows();
  const [review, setReview] = useState<RoutingReview>({ phase: "judging", preview: null, error: null });
  const [sending, setSending] = useState(false);
  const token = useRef(0);
  const objectiveId = objective.id;
  // 결과를 본 채 닫으면 그 결과가 다음 개시에 그대로 쓰인다고 알린다(데스크톱 시트와 같은 안내).
  const seen = useRef(false);
  const sheet = useBottomSheet(useCallback(() => {
    if (seen.current) say(t("objectives.routing.kept", { minutes: Math.round(ROUTING_PREVIEW_TTL_MS / 60_000) }));
    onClose();
  }, [onClose, say, t]));

  /** 결과를 (다시) 받는다 — 받는 동안 앞선 결과를 비워 「개시」가 낡은 결과로 나가지 않게 한다. reason 은 다시 받는 사정이다. */
  const load = useCallback((reason: RoutingReview["error"]) => {
    const mine = ++token.current;
    seen.current = false;
    setReview({ phase: "judging", preview: null, error: reason });
    void post<{ preview?: RoutingPreview }>(api, "/routing/preview", { objectiveId, language }).then((result) => {
      if (mine !== token.current) return;
      const preview = result?.preview ?? null;
      seen.current = preview !== null;
      setReview((current) => ({ phase: "ready", preview, error: preview ? current.error : { stage: "preview", code: "unknown" } }));
    }, (failure: unknown) => {
      if (mine !== token.current) return;
      setReview({ phase: "ready", preview: null, error: { stage: "preview", code: failure instanceof Error ? failure.message : "unknown" } });
    });
  }, [api, objectiveId, language]);
  useEffect(() => {
    load(null);
    // 닫힌 뒤 돌아온 응답은 버린다.
    return () => { token.current += 1; };
  }, [load]);

  const judging = review.phase === "judging";
  const ready = review.phase === "ready" && review.preview !== null;
  const go = async () => {
    const preview = review.preview;
    // 만료 판정은 서버에 맡긴다 — 폰 시계는 서버와 어긋날 수 있어, 서버의 routing_preview_stale 거절만 다시 받는 사정으로 삼는다.
    if (sending || !ready || !preview) return;
    setSending(true);
    try {
      const result = await post<{ failed?: readonly { role: string }[] }>(api, "/commander/start", { objectiveId, routing: "preview", language });
      const failed = result?.failed ?? [];
      if (failed.length) say(t("objectives.start.failedMembers", { count: failed.length, roles: failed.map((entry) => entry.role).join(", ") }));
      seen.current = false;
      sheet.close();
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "unknown";
      if (code === "routing_preview_stale") load({ stage: "start", code });
      else setReview((current) => ({ ...current, error: { stage: "start", code } }));
    } finally { setSending(false); }
  };

  const labels = { auto: t("objectives.commander.effortAuto"), fallback: t("objectives.launch.default") };
  const words = (model: string | undefined, effort: string | undefined) => { const shown = launchedWords(rows, model, effort, labels).words; return `${shown.model} · ${shown.effort}`; };
  const minutes = review.preview ? Math.floor((Date.now() - review.preview.at) / 60_000) : 0;
  const status = judging ? t("objectives.routing.judging") : !review.preview ? "" : review.preview.judged ? t("objectives.routing.judgedNow") : minutes <= 0 ? t("objectives.routing.cachedNow") : t("objectives.routing.cached", { minutes });
  const error = review.error;
  const errorText = !error ? null
    : error.code === "routing_preview_stale" ? t("objectives.mobile.routing.stale")
      : error.stage === "preview" ? t("objectives.routing.failed", { reason: error.code === "objective_busy" ? t("objectives.toast.busy") : routingReason(t, error.code) })
        : bandFailure(t, new Error(error.code), { message: false, talk: false });

  return (
    <BottomSheet sheet={sheet} t={t} title={t("objectives.routing.title")} busy={judging} focusOnOpen
      foot={(
        <button type="button" data-press="r3" className="objectives-m-pill2 is-inv" disabled={!ready || sending} aria-busy={sending || undefined} onClick={() => void go()}>
          {t("objectives.commander.start")}
        </button>
      )}>
      <p className="objectives-m-secnote" aria-live="polite">{status}</p>
      <div className="objectives-m-route">
        {targets.map((member) => {
          const entry = review.preview?.members.find((candidate) => candidate.id === member.id);
          // 폴백은 띄우는 순간의 지휘관 값으로 뜬다 — 데스크톱 시트와 같이 지금의 지휘관 모델을 보인다.
          const pick = judging ? t("objectives.routing.judgingRow")
            : !entry ? "—"
              : entry.via === "route" ? words(entry.model, entry.effort)
                : <>{words(objective.commander.model, objective.commander.effort)}<span className="objectives-m-route-tag">{t("objectives.members.fallback")}</span></>;
          const why = judging || !entry ? null : entry.via === "route" ? (entry.because ? { text: entry.because, warn: false } : null) : { text: t("objectives.routing.fallbackWhy", { reason: routingReason(t, entry.reason) }), warn: true };
          return (
            <div key={member.id} className="objectives-m-route-row">
              <span className="objectives-m-route-role">{member.role}</span>
              <span className="objectives-m-route-pick">{pick}</span>
              {why ? <span className={`objectives-m-route-why${why.warn ? " is-warn" : ""}`}>{why.text}</span> : null}
            </div>
          );
        })}
      </div>
      {errorText ? <p className="objectives-m-fault" role="alert">{errorText}</p> : ready ? <p className="objectives-m-secnote">{t("objectives.mobile.routing.hint", { count: targets.length })}</p> : null}
    </BottomSheet>
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
  const sheet = useBottomSheet(onClose);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const recipient = recipients.find((candidate) => candidate.id === to) ?? recipients[0] ?? null;
  const blocked = recipient?.state === "awaiting";

  useEffect(() => { fieldRef.current?.focus({ preventScroll: true }); }, []);

  const send = async () => {
    if (!recipient || blocked || sending || !text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await post(api, "/commander/message", { objectiveId, memberId: recipient.id === objectiveId ? null : recipient.id, text: text.trim(), language });
      say(t("objectives.message.sent", { role: recipient.role }));
      sheet.close();
    } catch (failure) {
      setError(bandFailure(t, failure, { message: true, talk: true }));
    } finally { setSending(false); }
  };

  const how = recipient ? `${t(HOW_KEYS[recipient.state] ?? "objectives.band.message.how.idle")}${recipient.id !== objectiveId && !blocked ? t("objectives.band.message.alsoCommander") : ""}` : "";
  return (
    <BottomSheet sheet={sheet} t={t} title={t("objectives.message")}
      foot={(
        <button type="button" data-press="r3" className="objectives-m-pill2 is-inv" disabled={!recipient || blocked || sending || !text.trim()} onClick={() => void send()}>
          {t(sending ? "objectives.decision.sending" : "objectives.mobile.message.send")}
        </button>
      )}>
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
    </BottomSheet>
  );
}
