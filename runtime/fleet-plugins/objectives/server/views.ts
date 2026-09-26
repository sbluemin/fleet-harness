import type { ConsoleCaller } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import type { PromptLanguage } from "./prompts.js";
import type { ObjectiveStore } from "./store.js";
import { commanderMode, latestRecord, missionReady, type Objective } from "./types.js";

/**
 * 보드 보기 — `fleet-objectives`(지휘관·담당의 작업 도구)와 `console_objectives`(Console Use)가 같은 모양으로 목표를 읽는다.
 * 도구 응답은 JSON 한 덩이: 텍스트와 structuredContent 가 같은 값이다.
 */

export function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: (value && typeof value === "object" && !Array.isArray(value) ? value : { value }) as Record<string, unknown>, isError: false };
}
export function refuse(error: string, extra: Record<string, unknown> = {}) {
  return { ...text({ error, ...extra }), isError: true };
}

/** 이 Operation 이 이 목표에서 맡은 자리 — 지휘관 또는 명단에 연결된 구성원. 둘 다 아니면 null. */
export function roleIn(objective: Objective, caller: ConsoleCaller | undefined): { role: "commander" } | { role: "member"; memberId: string } | null {
  if (caller?.kind !== "operation") return null;
  if (objective.id === caller.operationId) return { role: "commander" };
  const member = objective.members.find((candidate) => candidate.operationId === caller.operationId);
  return member ? { role: "member", memberId: member.id } : null;
}

export function createBoardViews(ctx: FleetPluginServerContext, store: ObjectiveStore) {
  const observe = (operationId: string) => {
    const node = ctx.host.operations.get(operationId);
    if (!node) return { operationId, title: null, state: "closed" as const };
    const observation = ctx.host.consoleControl?.observe(operationId) ?? null;
    return { operationId, title: node.title, state: observation ? (observation.lifecycle === "dormant" ? "dormant" : observation.activity) : "unknown" };
  };
  const graph = (objective: Objective) => ({
    commander: { ...observe(objective.id), session: objective.commander.sessionName },
    mode: commanderMode(objective.missions),
    ...(objective.planning ? { planning: true } : {}),
    // n 은 1부터 세는 임무 번호(편성 순서), missionId 는 변하지 않는 가리킴.
    missions: objective.missions.map((mission, index) => ({
      n: index + 1, missionId: mission.id, text: mission.text, done: mission.done,
      // 선행도 같은 1-based 번호로 — 목록에 없는 가리킴은 버린다.
      prerequisites: mission.prerequisites.map((id) => objective.missions.findIndex((candidate) => candidate.id === id) + 1).filter((value) => value >= 1),
      why: mission.why,
      member: mission.member ? ((member) => member ? { id: member.id, role: member.role } : null)(objective.members.find((candidate) => candidate.id === mission.member)) : null,
      ...(mission.unplaced ? { unplaced: true } : {}),
      ready: !mission.done && missionReady(objective.missions, mission),
      // 다음 임무가 받는 것 — 가장 최근 기록과 기록 수. 앞선 기록은 사람이 화면에서 읽는다.
      record: ((latest) => (latest ? { lines: latest.lines, kind: latest.kind, at: latest.at ? new Date(latest.at).toISOString() : null } : null))(latestRecord(mission)),
      records: mission.records.length,
      // 구성원 세션 상태는 명단에서 읽는다. 한 구성원은 여러 임무를 맡는다.
    })),
  });
  const objectiveView = (objective: Objective) => ({
    id: objective.id, theaterId: objective.theaterId, groupId: objective.groupId, title: objective.title, note: objective.note,
    // 메모에 붙인 이미지 — 이미지 자체는 싣지 않고 이 기계의 절대 경로만. 필요할 때 Read 로 연다(브라우저에는 이 경로가 가지 않는다).
    attachments: (objective.attachments ?? []).map((attachment) => ({ n: attachment.n, name: attachment.name, type: attachment.type, bytes: attachment.bytes, ...(attachment.width ? { width: attachment.width, height: attachment.height } : {}), path: store.attachmentPath(objective, attachment) })),
    dueDate: objective.dueDate, today: objective.today,
    // 달성 기준 — n 은 1부터, 기준을 가리키는 번호. met 은 지휘관이 충족으로 표시한 근거(없으면 미충족).
    criteria: objective.criteria.map((criterion, index) => ({ n: index + 1, id: criterion.id, text: criterion.text, by: criterion.by, met: criterion.met ?? null })),
    criteriaOpen: objective.criteriaOpen,
    criteriaProposals: objective.criteriaProposals.map((proposal, index) => ({ n: index + 1, id: proposal.id, kind: proposal.kind, target: proposal.target ?? null,
      targetN: proposal.target ? objective.criteria.findIndex((criterion) => criterion.id === proposal.target) + 1 : null,
      text: proposal.text ?? null, reason: proposal.reason ?? null, annotation: proposal.annotation ?? null })),
    members: objective.members.map((member) => ({ id: member.id, role: member.role, brief: member.brief ?? null, by: member.by, subagents: member.subagents, model: member.model ?? null, effort: member.effort ?? null, session: member.sessionName,
      ...(member.operationId ? observe(member.operationId) : { operationId: null, state: "missing" as const }) })),
    done: !!objective.done, awaitingReview: objective.awaitingReview, addedBy: objective.addedBy, graph: graph(objective),
    // 후속 후보 — 지휘관이 고치거나 거둘 수 있는 것은 open 뿐이다. 폐기 흔적은 제목·요약만.
    followups: objective.followups.map((candidate) => (candidate.state === "discarded"
      ? { id: candidate.id, state: candidate.state, title: candidate.title, summary: candidate.summary }
      : { id: candidate.id, rev: candidate.rev, state: candidate.state, title: candidate.title, summary: candidate.summary, brief: candidate.brief, criteria: candidate.criteria, evidence: candidate.evidence })),
    followupBatches: objective.followupBatches.map((batch) => ({ id: batch.id, at: new Date(batch.at).toISOString(), items: batch.items.map((entry) => ({ candidateId: entry.candidateId, title: entry.snapshot.title, state: entry.state, operationId: entry.operationId, error: entry.error })) })),
    // 이 목표가 후속으로 태어났다면 — 원본과 발견 당시의 근거.
    origin: objective.origin,
  });
  const rowView = (objective: Objective) => ({ id: objective.id, groupId: objective.groupId, title: objective.title, done: !!objective.done, awaitingReview: objective.awaitingReview, dueDate: objective.dueDate, today: objective.today, missions: `${objective.missions.filter((mission) => mission.done).length}/${objective.missions.length}`, mode: commanderMode(objective.missions), addedBy: objective.addedBy?.operationId ?? null });
  /** 알림 문구의 언어 — 목표가 띄운 세션에 objectiveLanguage 로 남아 있다. */
  const languageOf = (caller: ConsoleCaller | undefined): PromptLanguage => {
    if (caller?.kind !== "operation") return "en";
    return ctx.host.operations.get(caller.operationId)?.payload?.objectiveLanguage === "ko" ? "ko" : "en";
  };
  return { objectiveView, rowView, languageOf };
}
