import type { ConsoleOperationObservation } from "@fleet-console/sdk/mcp";
import type { Objective } from "./types.js";

export const STALL_MS = 30 * 60_000;
export type BoardObservation = Pick<ConsoleOperationObservation, "activity" | "lifecycle">;
export type BoardObserver = (operationId: string) => BoardObservation | null | undefined;
export type InboxReason = "decision" | "criteria" | "review" | "followup" | "followup-failed" | "pending" | "stalled";

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
    if (!objective.commenced) reasons.push("pending");
    if (objective.criteriaProposals.length) reasons.push("criteria");
    if (objective.decisionRequest) reasons.push("decision");
    if (objective.awaitingReview) reasons.push("review");
    if (options.observe && stalledObjectives([objective], options.observe, options.now).length) reasons.push("stalled");
  }
  if (objective.followups.some((candidate) => candidate.state === "open")) reasons.push("followup");
  if (objective.followupBatches.some((batch) => batch.items.some((item) => item.state === "failed" || item.state === "confirming"))) reasons.push("followup-failed");
  return reasons;
}
