import type { ConsoleOperationObservation } from "@fleet-console/sdk/mcp";
import type { Objective } from "./types.js";

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
