import type { ConversationSpeaker, GroupTimelineEntry, OperationClusterConversation } from "@fleet-console/sdk/conversation";
import { MAX_OBJECTIVE_ACTIONS, type Objective } from "../server/types.js";

/** Console에는 구현 컴포넌트 대신 명부 표식과 보드 사실만 건넨다. */
export function objectiveConversation(objective: Objective, toneAt: (index: number) => string, open: () => void): OperationClusterConversation {
  const members: ConversationSpeaker[] = objective.members.map((member, index) => ({ kind: "member", operationId: member.id, name: member.role, mark: { number: index + 1, tone: toneAt(index) } }));
  const events: GroupTimelineEntry[] = (objective.memberHistory ?? []).map((entry) => ({
    kind: entry.kind === "joined" ? "member-joined" : "member-left", id: `membership:${objective.id}:${entry.id}`, at: entry.at,
    speaker: { kind: "member", operationId: entry.memberId, name: entry.name, mark: { number: entry.number, tone: toneAt(entry.number - 1) } },
  }));
  const speaker: ConversationSpeaker = { kind: "commodore", name: "Commodore" };
  if (objective.addedBy && "kind" in objective.addedBy && objective.addedBy.kind === "commodore") events.push({
    kind: "board-action", id: `board:${objective.id}:added`, at: objective.createdAt, objectiveId: objective.id, speaker, action: "added", text: objective.addedBy.why ?? objective.title,
  });
  for (const action of objective.actions ?? []) if (typeof action.by === "object" && action.by.kind === "commodore") events.push({
    kind: "board-action", id: `board:${objective.id}:${action.id}`, at: action.at, objectiveId: objective.id, speaker, action: action.kind, text: action.by.why ?? action.kind,
  });
  for (const decision of objective.decisions) if (typeof decision.by === "object" && decision.by.kind === "commodore") events.push({
    kind: "board-action", id: `board:${objective.id}:${decision.id}`, at: decision.at, objectiveId: objective.id, speaker, action: "answer",
    text: [decision.question.text, ...decision.question.options.filter((option) => decision.answer.selectedOptionIds.includes(option.id)).map((option) => option.label), decision.answer.text, decision.by.why].filter(Boolean).join("\n"),
  });
  const request = !objective.done ? objective.decisionRequest : null;
  const truncated = (objective.memberHistory?.length ?? 0) >= MAX_OBJECTIVE_ACTIONS || Object.values(objective.actionCounts ?? {}).reduce((sum, count) => sum + count, 0) > (objective.actions?.length ?? 0);
  return { operationId: objective.id, members, events, truncated, decision: request ? {
    id: request.id, title: request.questions[0]?.text ?? objective.title, createdAt: request.createdAt,
    questions: request.questions.map((question) => ({ id: question.id, text: question.text, multiSelect: question.multiSelect, options: question.options })), open,
  } : null };
}
