import type { ConsoleOperationObservation } from "@fleet-console/sdk/mcp";
import type { Objective, ObjectiveOperator, ObjectivePersonHold, PersonHoldTarget, StoredPersonHold } from "./types.js";

export const STALL_MS = 30 * 60_000;
/** 구성원이 일하는 동안 지휘관이 이만큼 쉬면 정체다. */
export const COMMANDER_REST_MS = 15 * 60_000;
export type BoardObservation = Pick<ConsoleOperationObservation, "activity" | "lifecycle"> & {
  /** 쉬기 시작한 시각(ms) — `restClock` 이 얹는다. 없으면 오래 쉬었다고 추측하지 않는다. */
  readonly restingSince?: number;
};
export type BoardObserver = (operationId: string) => BoardObservation | null | undefined;
const resting = (observation: BoardObservation): boolean => observation.lifecycle === "dormant" || observation.activity === "idle";
const working = (observation: BoardObservation): boolean => observation.lifecycle === "live" && (observation.activity === "running" || observation.activity === "background");

/**
 * 호스트 관측 위에 쉬기 시작한 시각을 얹는다. 처음 본 휴식은 본 시각부터 세고, 쉬는 동안 턴이 하나라도 닫혔으면(live 의 세대·revision 이
 * 바뀜) 그때부터 다시 센다 — 관측 사이에 지나간 턴을 휴식으로 잇지 않는다. 휴면으로 들어가도 그 휴식은 이어지고, 휴면에서 깨어나면 새로 센다.
 */
export function restClock<T extends Pick<ConsoleOperationObservation, "activity" | "lifecycle" | "generation"> & { readonly output?: { readonly revision?: number } }>(
  observe: (operationId: string) => T | null | undefined, now: () => number = () => Date.now(),
): (operationId: string) => (T & { readonly restingSince?: number }) | null {
  const seen = new Map<string, { readonly turn: string | null; readonly since: number }>();
  return (operationId) => {
    const observation = observe(operationId) ?? null;
    if (!observation || !resting(observation)) { seen.delete(operationId); return observation; }
    const turn = observation.lifecycle === "live" ? `${observation.generation ?? ""}:${observation.output?.revision ?? ""}` : null;
    const previous = seen.get(operationId);
    const since = previous && (turn === null || previous.turn === turn) ? previous.since : now();
    seen.set(operationId, { turn: turn ?? previous?.turn ?? null, since });
    return { ...observation, restingSince: since };
  };
}
export type InboxReason = "decision" | "criteria" | "review" | "followup" | "followup-failed" | "pending" | "planned" | "stalled" | "member-failed";

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

export type { ObjectiveOperator };

/** 운영 판정이 읽는 목표의 사실 — 저장 레코드와 목표 보기가 같은 모양으로 넘긴다. */
interface OperatorFacts {
  readonly commodoreOperated?: boolean;
  readonly addedBy?: unknown;
  readonly origin?: { readonly objectiveId: string; readonly candidateId: string } | null;
}
/** 후속의 원본에서 읽는 것 — 누가 어떤 후보를 골랐나. */
interface OperatorSource {
  readonly followupBatches?: readonly { readonly by?: unknown; readonly items: readonly { readonly candidateId: string }[] }[];
}
const isCommodore = (actor: unknown): boolean => typeof actor === "object" && actor !== null && "kind" in actor && actor.kind === "commodore";

/**
 * 목표를 운영하는 쪽 — 사령관 깨움(보드 사건·inbox 집계), 조회의 `operator`, 목표 보기의 `operator`(화면)가 이 하나를 쓴다.
 * 정해 둔 값이 있으면 그것(사령관이 고른 후속은 태어날 때 false)이고, 없으면 필드가 없는 옛 레코드만 사령관이 만든 목표(직접 추가했거나
 * 사령관이 고른 후속)를 사령관으로 본다. 개시한 손(`commencedBy`)은 기준이 아니다. `find` 는 후속의 원본을 찾는 데만 쓴다.
 */
export function objectiveOperator(objective: OperatorFacts, find: (objectiveId: string) => OperatorSource | null | undefined): ObjectiveOperator {
  if (typeof objective.commodoreOperated === "boolean") return objective.commodoreOperated ? "commodore" : "human";
  return createdByCommodore(objective, find) ? "commodore" : "human";
}

/** 사령관이 만든 목표 — 직접 추가했거나, 사령관이 고른 후속 후보에서 생겼다. */
export function createdByCommodore(objective: OperatorFacts, find: (objectiveId: string) => OperatorSource | null | undefined): boolean {
  if (isCommodore(objective.addedBy)) return true;
  const origin = objective.origin;
  if (!origin) return false;
  return !!find(origin.objectiveId)?.followupBatches?.some((batch) => isCommodore(batch.by) && batch.items.some((item) => item.candidateId === origin.candidateId));
}

/**
 * 정체 판단의 시간 조건을 뺀 관문 — `stalledObjectives`와 에피소드 판별이 함께 쓴다.
 * 관측할 수 없는 세션을 유휴라고 추측하지 않는다.
 */
export function stallGate(objective: Objective): boolean {
  return !!objective.commenced && !objective.done && !objective.removed && !objective.planning && !objective.awaitingReview && !objective.awaitingHandoff && !objective.decisionRequest && !objective.criteriaProposals.length && objective.missions.some((mission) => !mission.done);
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
    if (!objective.commenced) {
      // 구상을 청해 지휘관이 짜는 중인 목표는 아무도 기다리지 않는다 — 구상이 내려앉으면 planned·criteria 로 다시 선다.
      if (!objective.missions.length) { if (!objective.planning) reasons.push("pending"); }
      else if (!objective.criteriaProposals.length) {
        const commander = options.observe?.(objective.id);
        // 관측 없는 보드 서명도 구상 전과 개시 대기를 구별한다. 관측이 있으면 진행 중인 구상을 개시 대기로 부르지 않는다.
        if (!options.observe || commander?.lifecycle === "dormant" || commander?.activity === "idle" || commander?.activity === "ended") reasons.push("planned");
      }
    }
    if (objective.criteriaProposals.length) reasons.push("criteria");
    if (objective.decisionRequest) reasons.push("decision");
    if (objective.awaitingReview) reasons.push("review");
    if (objective.members.some((member) => member.failure && !member.failure.acknowledged)) reasons.push("member-failed");
    if (options.observe && stalledObjectives([objective], options.observe, options.now).length) reasons.push("stalled");
  }
  if (followupsJudgeable(objective) && objective.followups.some((candidate) => candidate.state === "open")) reasons.push("followup");
  if (objective.followupBatches.some((batch) => batch.items.some((item) => item.state === "failed" || item.state === "confirming"))) reasons.push("followup-failed");
  return reasons;
}

/** 후속 후보를 판단할 때인가 — 검토 대기이거나 완료 뒤. 진행 중의 후보는 모이기만 한다. */
export const followupsJudgeable = (subject: { readonly awaitingReview: boolean; readonly done?: unknown }): boolean => subject.awaitingReview || !!subject.done;
/** 진행 중 후보 판단 거절(not_in_review)의 안내. */
export const FOLLOWUPS_AT_REVIEW_HINT = "Follow-up candidates only collect while the objective works; judge them all at once when it awaits review.";

/**
 * 누가 답할 차례인가 — 대기 이유마다 하나. 사람이 운영하는 목표는 모두 사람이고, 사령관이 운영하는 목표는 사령관이 사람에게
 * 넘긴 항목(`livePersonHold`)만 사람이다. 자율 운영이 꺼져 있으면 사령관 몫도 사람에게 돌아온다 — 그 판정은 자율 운영 상태를
 * 아는 화면이 이 값 위에 얹는다(보드는 넘김과 운영 주체만 안다).
 */
export type InboxAwaits = "person" | "commodore";
/** 사람에게 넘길 수 있는 대기 이유와 그 대상 — 다른 이유(개시·정체·구성원 실패·후속 생성 실패)는 넘기지 않는다. */
const HOLD_TARGET_OF: Readonly<Partial<Record<InboxReason, PersonHoldTarget>>> = { decision: "decision", criteria: "criteria", review: "review", followup: "followup" };
export const holdTargetOf = (reason: InboxReason): PersonHoldTarget | null => HOLD_TARGET_OF[reason] ?? null;

/** 넘긴 항목이 서 있는지 보는 데 필요한 사실 — 저장 레코드와 목표 보기가 같은 모양으로 넘긴다. */
export interface HoldSubject {
  readonly decisionRequest?: { readonly id: string } | null;
  readonly criteriaProposals?: readonly unknown[] | null;
  readonly awaitingReview: boolean;
  readonly done?: unknown;
  readonly followups?: readonly { readonly state: string }[] | null;
}
/** 넘긴 항목이 아직 서 있는가 — 결정 요청은 넘긴 그 요청이어야 한다. 사람의 처리 없이 사라진 항목의 넘김은 효력이 없다. */
export function heldItemStands(subject: HoldSubject, hold: Pick<StoredPersonHold, "target" | "requestId">): boolean {
  switch (hold.target) {
    case "decision": return !!subject.decisionRequest && subject.decisionRequest.id === hold.requestId;
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
/** 대기 이유 하나의 차례 — 운영 주체는 기본으로 목표의 판정을 쓴다. */
export function reasonAwaits(objective: Objective, reason: InboxReason, operator: ObjectiveOperator = objective.operator): InboxAwaits {
  if (operator === "human") return "person";
  const target = holdTargetOf(reason);
  return target && livePersonHold(objective, target) ? "person" : "commodore";
}
/** 대기 이유마다 차례 — inbox 줄의 `awaits`. */
export function inboxAwaits(objective: Objective, reasons: readonly InboxReason[]): Readonly<Partial<Record<InboxReason, InboxAwaits>>> {
  return Object.fromEntries(reasons.map((reason) => [reason, reasonAwaits(objective, reason)]));
}
