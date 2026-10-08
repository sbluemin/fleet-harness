import type { ConsoleOperationObservation } from "@fleet-console/sdk/mcp";
import type { Objective, ObjectiveOperator } from "./types.js";

export const STALL_MS = 30 * 60_000;
export type BoardObservation = Pick<ConsoleOperationObservation, "activity" | "lifecycle">;
export type BoardObserver = (operationId: string) => BoardObservation | null | undefined;
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
 * 정해 둔 값이 있으면 그것, 없으면 사령관이 만든 목표(직접 추가했거나 사령관이 고른 후속)만 사령관이다. 개시한 손(`commencedBy`)은
 * 기준이 아니다. `find` 는 후속의 원본을 찾는 데만 쓴다.
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

/** 임무가 남고 보드가 오래 그대로인 목표. 관측할 수 없는 세션을 유휴라고 추측하지 않는다. */
export function stalledObjectives(objectives: readonly Objective[], observe: BoardObserver, now = Date.now()): readonly string[] {
  return objectives.filter((objective) => {
    if (!objective.commenced || objective.done || objective.removed || objective.planning || objective.awaitingReview || objective.awaitingHandoff || objective.decisionRequest || objective.criteriaProposals.length || !objective.missions.some((mission) => !mission.done)) return false;
    if (now - (objective.boardUpdatedAt ?? objective.createdAt) < STALL_MS) return false;
    const ids = [objective.id, ...objective.members.filter((member) => member.sessionName !== null).map((member) => member.id)];
    return ids.every((id) => {
      const observation = observe(id);
      return !!observation && (observation.lifecycle === "dormant" || observation.activity === "idle");
    });
  }).map((objective) => objective.id);
}

/** 목표마다 해당하는 이유를 한 번씩. 완료 뒤에도 미처리 후속은 사람·사령관의 inbox에 남는다. */
export function inboxReasons(objective: Objective, options: { readonly observe?: BoardObserver; readonly now?: number } = {}): readonly InboxReason[] {
  if (objective.removed) return [];
  const reasons: InboxReason[] = [];
  if (!objective.done) {
    if (!objective.commenced) {
      if (!objective.missions.length) reasons.push("pending");
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
  if (objective.followups.some((candidate) => candidate.state === "open")) reasons.push("followup");
  if (objective.followupBatches.some((batch) => batch.items.some((item) => item.state === "failed" || item.state === "confirming"))) reasons.push("followup-failed");
  return reasons;
}
