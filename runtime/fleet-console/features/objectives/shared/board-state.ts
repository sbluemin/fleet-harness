import type { ConsoleObjectiveObservation } from "../../execution/shared/control.js";
import type { Objective, ObjectivePersonHold, PersonHoldTarget, StoredPersonHold } from "./types.js";
import { liftNestedActivity } from "./records/activity.js";

/** 사령관이 맡아 기다리는 목표. 호스트 명부와 모든 사람 화면이 같은 판정을 쓴다. */
export function isCommodoreWaiting(objective: Objective): boolean {
  if (objective.removed || objective.done) return false;
  const kept = (target: PersonHoldTarget) => !livePersonHold(objective, target);
  return (!objective.commenced && !(objective.criteriaProposals.length > 0 && !kept("criteria")))
    || (objective.criteriaProposals.length > 0 && kept("criteria"))
    || (objective.awaitingReview && kept("review"))
    || (followupsJudgeable(objective) && objective.followups.some((followup) => followup.state === "open") && kept("followup"));
}

export const STALL_MS = 30 * 60_000;
/** 구성원이 일하는 동안 지휘관이 이만큼 쉬면 정체다. */
export const COMMANDER_REST_MS = 15 * 60_000;
export type BoardObservation = Pick<ConsoleObjectiveObservation, "activity" | "lifecycle"> & {
  /** 쉬기 시작한 시각(ms) — `restClock` 이 얹는다. 없으면 오래 쉬었다고 추측하지 않는다. */
  readonly restingSince?: number;
};
export type BoardObserver = (objectiveId: string) => BoardObservation | null | undefined;
const resting = (observation: BoardObservation): boolean => observation.lifecycle === "dormant" || observation.activity === "idle";
const working = (observation: BoardObservation): boolean => observation.lifecycle === "live" && (observation.activity === "running" || observation.activity === "background");

/**
 * 호스트 관측 위에 쉬기 시작한 시각을 얹는다. 처음 본 휴식은 본 시각부터 세고, 쉬는 동안 턴이 하나라도 닫혔으면(live 의 세대·revision 이
 * 바뀜) 그때부터 다시 센다 — 관측 사이에 지나간 턴을 휴식으로 잇지 않는다. 휴면으로 들어가도 그 휴식은 이어지고, 휴면에서 깨어나면 새로 센다.
 */
export function restClock<T extends Pick<ConsoleObjectiveObservation, "activity" | "lifecycle" | "generation"> & { readonly output?: { readonly revision?: number } }>(
  observe: (objectiveId: string) => T | null | undefined, now: () => number = () => Date.now(),
): (objectiveId: string) => (T & { readonly restingSince?: number }) | null {
  const seen = new Map<string, { readonly turn: string | null; readonly since: number }>();
  return (objectiveId) => {
    const observation = observe(objectiveId) ?? null;
    if (!observation || !resting(observation)) { seen.delete(objectiveId); return observation; }
    const turn = observation.lifecycle === "live" ? `${observation.generation ?? ""}:${observation.output?.revision ?? ""}` : null;
    const previous = seen.get(objectiveId);
    const since = previous && (turn === null || previous.turn === turn) ? previous.since : now();
    seen.set(objectiveId, { turn: turn ?? previous?.turn ?? null, since });
    return { ...observation, restingSince: since };
  };
}
export type InboxReason = "criteria" | "review" | "followup" | "followup-failed" | "pending" | "planned" | "stalled" | "member-failed";

/**
 * 목표의 상태 — 목록의 구역보다 잘게, 사람이 「목표가 어디까지 왔나」로 읽는 단계. 대기 이유(inbox)와 달리 지금 서 있는 한 자리다.
 * 사령관은 이 값이 바뀔 때마다 깨어난다(자기 손으로 바꾼 것은 빼고).
 */
export type ObjectiveStatus = "pending" | "planning" | "planned" | "running" | "missions-done" | "review" | "done" | "removed";
export function objectiveStatus(objective: Objective): ObjectiveStatus {
  if (objective.removed) return "removed";
  if (objective.done) return "done";
  if (objective.awaitingReview) return "review";
  if (!objective.commenced) return objective.planning ? "planning" : objective.missions.length ? "planned" : "pending";
  if (objective.awaitingHandoff) return "missions-done";
  return "running";
}

/**
 * 정체 판단의 시간 조건을 뺀 관문 — `stalledObjectives`와 에피소드 판별이 함께 쓴다.
 * 관측할 수 없는 세션을 유휴라고 추측하지 않는다.
 */
export function stallGate(objective: Objective): boolean {
  return !!objective.commenced && !objective.done && !objective.removed && !objective.planning && !objective.awaitingReview && !objective.awaitingHandoff && !objective.criteriaProposals.length && objective.missions.some((mission) => !mission.done);
}

/**
 * 정체 에피소드의 서명 — 통지한 에피소드가 같은 조건으로 다시 보여도 깨우지 않기 위한 것.
 * 보드 시계와 일하는 구성원 명단으로만 삼는다: 통지 때문에 생긴 지휘관 턴은 서명을 바꾸지 않으므로
 * 같은 에피소드의 되울림이 새 정체가 되지 않는다. 보드가 앞으로 가거나 일하는 명단이 바뀌면 새 에피소드다.
 * 관문을 못 넘으면 null.
 */
export function stallEpisode(objective: Objective, observe: BoardObserver): string | null {
  if (!stallGate(objective)) return null;
  const workingIds = objective.members
    .filter((member) => member.sessionName !== null && ((observation) => !!observation && working(observation))(observe(member.id)))
    .map((member) => member.id)
    .sort();
  return `${objective.boardUpdatedAt ?? objective.createdAt}|${workingIds.join(",")}`;
}

/**
 * 임무가 남은 목표 중 정체 — 구성원이 일하는 동안 지휘관이 `COMMANDER_REST_MS` 이상 쉬었거나, 보드가 `STALL_MS` 넘게 그대로인데 모두 쉰다.
 * 관측할 수 없는 세션을 유휴라고 추측하지 않는다.
 */
export function stalledObjectives(objectives: readonly Objective[], observe: BoardObserver, now = Date.now()): readonly string[] {
  return objectives.filter((objective) => {
    if (!stallGate(objective)) return false;
    const commander = observe(objective.id);
    if (!commander || !resting(commander)) return false;
    const members = objective.members.filter((member) => member.sessionName !== null).map((member) => observe(member.id));
    if (workingWhileCommanderRests(commander, members, now)) return true;
    return now - (objective.boardUpdatedAt ?? objective.createdAt) >= STALL_MS && members.every((observation) => !!observation && resting(observation));
  }).map((objective) => objective.id);
}
const workingWhileCommanderRests = (commander: BoardObservation, members: readonly (BoardObservation | null | undefined)[], now: number): boolean =>
  commander.restingSince !== undefined && now - commander.restingSince >= COMMANDER_REST_MS && members.some((observation) => !!observation && working(observation));

/**
 * 그룹 대화가 대기 중인가 — 화면의 대화 행이 「대기 중」이라 부르는 그 끌어올림(`liftNestedActivity`)이 idle 이다: 지휘관과 띄운
 * 구성원 누구도 일하거나(running·background) 허용을 기다리지(awaiting) 않는다. 휴면한 지휘관은 쉬는 것이다. 지휘관을 관측할 수
 * 없으면(세션이 없거나 모름) 그룹이 없는 것이라 대기 중이 아니다.
 */
export function groupIdle(objective: Pick<Objective, "id" | "members">, observe: BoardObserver): boolean {
  const commander = observe(objective.id);
  if (!commander) return false;
  const own = commander.lifecycle === "dormant" ? "idle" : commander.lifecycle === "live" ? commander.activity : "unknown";
  if (own !== "idle" && own !== "ended") return false;
  const members = objective.members.filter((member) => member.sessionName !== null).flatMap((member) => {
    const observation = observe(member.id);
    return observation?.lifecycle === "live" ? [observation.activity] : [];
  });
  return liftNestedActivity("idle", members) === "idle";
}

/** 지휘관이 쉬는 동안 일하는 구성원과 그 휴식의 분 — 정체 통지가 싣는 사실. 그 갈래의 정체가 아니면 null. */
export function commanderRestFacts(objective: Objective, observe: BoardObserver, now = Date.now()): { readonly roles: readonly string[]; readonly minutes: number } | null {
  const commander = observe(objective.id);
  if (!commander || !resting(commander) || commander.restingSince === undefined) return null;
  const busy = objective.members.filter((member) => member.sessionName !== null && ((observation) => !!observation && working(observation))(observe(member.id)));
  if (!workingWhileCommanderRests(commander, busy.map((member) => observe(member.id)), now)) return null;
  return { roles: busy.map((member) => member.role), minutes: Math.floor((now - commander.restingSince) / 60_000) };
}

/**
 * 목표마다 해당하는 이유를 한 번씩. 후속 후보는 진행 중에는 모이기만 하고, 검토 대기(인계 뒤)에 검토와 함께 한 번에 판단할
 * 대기로 선다. 완료 뒤에도 미처리 후속은 사람·사령관의 inbox에 남는다.
 */
export function inboxReasons(objective: Objective, options: { readonly observe?: BoardObserver; readonly now?: number } = {}): readonly InboxReason[] {
  if (objective.removed) return [];
  const reasons: InboxReason[] = [];
  if (!objective.done) {
    // 관측 없는 보드 서명도 구상 전과 개시 대기를 구별한다. 관측이 있으면 진행 중인 구상을 개시 대기로 부르지 않는다.
    const commanderRests = () => {
      const commander = options.observe?.(objective.id);
      return !options.observe || commander?.lifecycle === "dormant" || commander?.activity === "idle" || commander?.activity === "ended";
    };
    if (!objective.commenced) {
      // 구상을 청해 지휘관이 짜는 중인 목표는 아무도 기다리지 않는다 — 구상이 내려앉으면 planned·criteria 로 다시 선다.
      if (!objective.missions.length) { if (!objective.planning) reasons.push("pending"); }
      else if (!objective.criteriaProposals.length && commanderRests()) reasons.push("planned");
    // 이미 개시한 목표의 다시 구상한 회차(확장이든 일반 재계획이든)도 같은 길이다 — 구상이 기준 제안 없이 내려앉으면 개시 대기로 선다.
    } else if (objective.planning && !objective.criteriaProposals.length
      && objective.missions.some((mission) => !mission.done) && commanderRests()) reasons.push("planned");
    if (objective.criteriaProposals.length) reasons.push("criteria");
    if (objective.awaitingReview) reasons.push("review");
    if (objective.members.some((member) => member.failure && !member.failure.acknowledged)) reasons.push("member-failed");
    if (options.observe && stalledObjectives([objective], options.observe, options.now).length) reasons.push("stalled");
  }
  if (followupsJudgeable(objective) && objective.followups.some((candidate) => candidate.state === "open")) reasons.push("followup");
  if (objective.followupBatches.some((batch) => batch.items.some((item) => item.state === "failed" || item.state === "confirming"))) reasons.push("followup-failed");
  return reasons;
}

/** 그룹의 지금 활동 — 지휘관과 띄운 구성원 전체. `idle` 은 모두 쉼, `awaiting` 은 허용·입력 대기, `unknown` 은 지휘관을 관측할 수 없음(쉬는 것으로 추측하지 않는다). */
export type GroupState = "idle" | "working" | "awaiting" | "unknown";
export function groupState(objective: Pick<Objective, "id" | "members">, observe: BoardObserver): GroupState {
  const commander = observe(objective.id);
  if (!commander) return "unknown";
  const own = commander.lifecycle === "dormant" ? "idle" : commander.lifecycle === "live" ? commander.activity : "unknown";
  if (own === "unknown") return "unknown";
  // 띄운 구성원은 쉬는 것이 확인돼야 쉰다 — 관측할 수 없는 구성원을 전원 휴식으로 치지 않는다. 휴면은 쉬는 것이다.
  const members: string[] = [];
  for (const member of objective.members) {
    if (member.sessionName === null) continue;
    const observation = observe(member.id);
    if (observation?.lifecycle === "live") members.push(observation.activity);
    else if (observation?.lifecycle !== "dormant") return "unknown";
  }
  const lifted = liftNestedActivity(own, members);
  return lifted === "awaiting" ? "awaiting" : lifted === "idle" || lifted === "ended" ? "idle" : "working";
}

/** 기준 처리 뒤 재개 호출을 권하지 않는 이유 — 응답의 hint 가 이 이유를 한 줄로 말한다. */
export type CriteriaSettleState = "resume" | "rejected-plan" | "proposals" | "held" | "review" | "handoff" | "stopped" | "awaiting" | "unknown" | "working" | "planning" | "done" | "removed";
/**
 * 기준 승인·거절 직후, 처리 뒤의 보드와 그룹 활동으로 사령관이 이어서 부를 재개 action 하나(steer·commence)나 null. 상태 판정만 맡고 문장은 호출자가 쓴다.
 * 쉬는 지휘관을 깨우는 것은 사령관의 개시나 스티어링뿐이다. 개시는 최초 착수 여부가 아니라 현재 회차가 개시를 기다리는지(`planned`)로 가른다 — 확장 회차도 같다.
 * 거절은 남은 계획을 승인한 것이 아니므로 구상 중 거절은 개시를 권하지 않는다. 사람에게 넘긴 항목·결정·검토·인계 대기·중단은 재개를 권하지 않는다.
 */
export function criteriaSettleAdvice(objective: Objective, observe: BoardObserver, rejected = false): { readonly group: GroupState; readonly next: "steer" | "commence" | null; readonly state: CriteriaSettleState } {
  const group = groupState(objective, observe);
  const none = (state: CriteriaSettleState) => ({ group, next: null, state });
  if (objective.removed) return none("removed");
  if (objective.done) return none("done");
  if (objective.criteriaProposals.length) return none("proposals");
  if ((objective.personHolds ?? []).some((hold) => livePersonHold(objective, hold.target))) return none("held");
  if (objective.awaitingReview) return none("review");
  if (objective.stoppedAt) return none("stopped");
  if (group === "unknown" || group === "awaiting" || group === "working") return none(group);
  if (inboxReasons(objective, { observe }).includes("planned")) return rejected ? none("rejected-plan") : { group, next: "commence", state: "resume" };
  if (objective.awaitingHandoff) return none("handoff");
  return objective.commenced && !objective.planning ? { group, next: "steer", state: "resume" } : none("planning");
}

/** 후속 후보를 판단할 때인가 — 검토 대기이거나 완료 뒤. 진행 중의 후보는 모이기만 한다. */
export const followupsJudgeable = (subject: { readonly awaitingReview: boolean; readonly done?: unknown }): boolean => subject.awaitingReview || !!subject.done;
/** 진행 중 후보 판단 거절(not_in_review)의 안내. */
export const FOLLOWUPS_AT_REVIEW_HINT = "Follow-up candidates only collect while the objective works; judge them all at once when it awaits review.";

/**
 * 누가 답할 차례인가 — 모든 목표를 사령관이 운영하므로 사령관이 사람에게
 * 넘긴 항목(`livePersonHold`)만 사람이다. 자율 운영이 꺼져 있으면 사령관 몫도 사람에게 돌아온다 — 그 판정은 자율 운영 상태를
 * 아는 화면이 이 값 위에 얹는다(보드는 넘김만 안다).
 */
export type InboxAwaits = "person" | "commodore";
/** 사람에게 넘길 수 있는 대기 이유와 그 대상 — 다른 이유(개시·정체·구성원 실패·후속 생성 실패)는 넘기지 않는다. */
const HOLD_TARGET_OF: Readonly<Partial<Record<InboxReason, PersonHoldTarget>>> = { criteria: "criteria", review: "review", followup: "followup" };
export const holdTargetOf = (reason: InboxReason): PersonHoldTarget | null => HOLD_TARGET_OF[reason] ?? null;

/** 넘긴 항목이 서 있는지 보는 데 필요한 사실 — 저장 레코드와 목표 보기가 같은 모양으로 넘긴다. */
export interface HoldSubject {
  readonly criteriaProposals?: readonly unknown[] | null;
  readonly awaitingReview: boolean;
  readonly done?: unknown;
  readonly followups?: readonly { readonly state: string }[] | null;
}
/** 넘긴 항목이 아직 서 있는가 — 결정 요청은 넘긴 그 요청이어야 한다. 사람의 처리 없이 사라진 항목의 넘김은 효력이 없다. */
export function heldItemStands(subject: HoldSubject, hold: Pick<StoredPersonHold, "target" | "requestId">): boolean {
  switch (hold.target) {
    case "criteria": return !!subject.criteriaProposals?.length;
    case "review": return subject.awaitingReview && !subject.done;
    case "followup": return followupsJudgeable(subject) && !!subject.followups?.some((candidate) => candidate.state === "open");
  }
}
/** 지금 사람이 답할 차례인 넘김 — 끝나지 않았고 그 항목이 서 있다. 없으면 null. */
export function livePersonHold(objective: HoldSubject & { readonly personHolds?: readonly ObjectivePersonHold[] }, target: PersonHoldTarget): ObjectivePersonHold | null {
  const hold = (objective.personHolds ?? []).find((entry) => entry.target === target);
  return hold && !hold.settled && heldItemStands(objective, { target, ...(hold.requestId ? { requestId: hold.requestId } : {}) }) ? hold : null;
}
/** 대기 이유 하나의 차례. */
export function reasonAwaits(objective: Objective, reason: InboxReason): InboxAwaits {
  const target = holdTargetOf(reason);
  return target && livePersonHold(objective, target) ? "person" : "commodore";
}
/** 대기 이유마다 차례 — inbox 줄의 `awaits`. */
export function inboxAwaits(objective: Objective, reasons: readonly InboxReason[]): Readonly<Partial<Record<InboxReason, InboxAwaits>>> {
  return Object.fromEntries(reasons.map((reason) => [reason, reasonAwaits(objective, reason)]));
}
