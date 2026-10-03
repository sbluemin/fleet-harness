import type { ConsoleCaller } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import type { PromptLanguage } from "./prompts.js";
import type { ObjectiveResult } from "./results.js";
import type { ObjectiveStore } from "./store.js";
import { commanderMode, extensionOf, latestRecord, missionReady, ownAnswer, type Objective } from "./types.js";

/** 목록 한 줄에 싣는 브리핑의 앞부분 길이 — 목표 여럿을 한 번에 견주는 데 쓰고, 전문은 목표 하나를 읽는다. */
const ROW_BRIEF = 600;

/** 모델이 읽는 보드에서 비어 있는 값(null·빈 문자열·빈 배열·false)은 싣지 않는다 — 없음은 비어 있음이다. */
const withoutEmpty = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== "" && entry !== false && !(Array.isArray(entry) && entry.length === 0))) as Partial<T>;

/**
 * 결과물 한 건 — 모델이 가리키고 판단하는 데 쓰는 것만. 해시·크기·형식·저장 시각은 서버가 지키는 값이고, PR 의 host·owner·repo·number 는 url 에 있다.
 * PR 관측은 지금 상태 하나로, 조회가 실패했을 때만 마지막으로 확인한 상태를 함께 싣는다.
 */
const resultView = (result: ObjectiveResult) => {
  const common = withoutEmpty({ id: result.id, kind: result.kind, label: result.label, note: result.note, sourceMissionId: result.sourceMissionId });
  if (result.kind === "evidence") return { ...common, name: result.name };
  if (result.kind === "artifact") return { ...common, url: result.url };
  const observation = result.observation;
  return { ...common, url: result.url, state: observation.state, ...withoutEmpty({ title: observation.title, stale: observation.stale }),
    ...(observation.state === "error" ? { error: observation.error.code, ...(observation.lastSuccess ? { lastState: observation.lastSuccess.state } : {}) } : {}) };
};

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
  const member = objective.members.find((candidate) => candidate.id === caller.operationId && candidate.sessionName !== null);
  return member ? { role: "member", memberId: member.id } : null;
}

export function createBoardViews(ctx: FleetPluginServerContext, store: ObjectiveStore) {
  const observe = (operationId: string) => {
    const reference = ctx.host.operations.describe?.(operationId);
    const node = reference?.operation ?? ctx.host.operations.get(operationId);
    if (!node) return { operationId, title: null, state: "closed" as const };
    if (reference?.location === "archived") return { operationId, title: node.title, state: "dormant" as const };
    const observation = ctx.host.consoleControl?.observe(operationId) ?? null;
    return { operationId, title: node.title, state: observation ? (observation.lifecycle === "dormant" ? "dormant" : observation.activity) : "unknown" };
  };
  const graph = (objective: Objective) => {
    const nOf = (missionId: string) => objective.missions.findIndex((candidate) => candidate.id === missionId) + 1;
    return {
      // 지휘관 Operation 은 목표와 같은 id·제목이다 — 상태와 세션 이름만.
      // 기동 전 목표에는 지휘관 Operation 이 아직 없다 — 닫힘(closed)이 아니라 시작 전이다.
      commander: { state: store.pending(objective.id) ? "not_started" as const : observe(objective.id).state, session: objective.commander.sessionName },
      ...(objective.planning ? { planning: true } : {}),
      // n 은 1부터 세는 임무 번호(편성 순서), missionId 는 변하지 않는 가리킴.
      missions: objective.missions.map((mission, index) => {
        // 선행과 그 이유를 같은 1-based 번호로 — 목록에 없는 가리킴은 버린다.
        const why = Object.fromEntries(Object.entries(mission.why ?? {}).flatMap(([id, reason]) => (nOf(id) >= 1 && reason ? [[String(nOf(id)), reason]] : [])));
        const latest = latestRecord(mission);
        return {
          n: index + 1, missionId: mission.id, text: mission.text, done: mission.done,
          ...withoutEmpty({ by: mission.by, memberBy: mission.memberBy, extension: extensionOf(objective.extensions, mission.id, "mission") }),
          prerequisites: mission.prerequisites.map(nOf).filter((value) => value >= 1),
          ...(Object.keys(why).length ? { why } : {}),
          member: mission.member ? ((member) => member ? { id: member.id, role: member.role } : null)(objective.members.find((candidate) => candidate.id === mission.member)) : null,
          ...(mission.unplaced ? { unplaced: true } : {}),
          ...(mission.done ? {} : { ready: missionReady(objective.missions, mission) }),
          // 다음 임무가 받는 것 — 가장 최근 기록과 기록 수. 앞선 기록은 사람이 화면에서 읽는다.
          ...(latest ? { record: { lines: latest.lines, kind: latest.kind, ...(latest.at ? { at: new Date(latest.at).toISOString() } : {}) }, records: mission.records.length } : {}),
          // 구성원 세션 상태는 명단에서 읽는다. 한 구성원은 여러 임무를 맡는다.
        };
      }),
    };
  };
  const objectiveView = (objective: Objective) => ({
    id: objective.id, theaterId: objective.theaterId, title: objective.title,
    ...withoutEmpty({
      // 사람이 쓴 목표 설명 — 도구 설명이 부르는 이름(brief)으로 싣는다.
      groupId: objective.groupId, brief: objective.note,
      // 메모에 붙인 이미지 — 이미지 자체는 싣지 않고 이 기계의 절대 경로만. 필요할 때 Read 로 연다(브라우저에는 이 경로가 가지 않는다).
      attachments: (objective.attachments ?? []).map((attachment) => ({ n: attachment.n, name: attachment.name, type: attachment.type, bytes: attachment.bytes, ...(attachment.width ? { width: attachment.width, height: attachment.height } : {}), path: store.attachmentPath(objective, attachment) })),
      results: objective.results.map(resultView),
      dueDate: objective.dueDate, today: objective.today,
      // 달성 기준 — n 은 1부터, 기준을 가리키는 번호. met 은 지휘관이 충족으로 표시한 근거(없으면 미충족).
      criteria: objective.criteria.map((criterion, index) => ({ n: index + 1, id: criterion.id, text: criterion.text, by: criterion.by, met: criterion.met ?? null, ...withoutEmpty({ extension: extensionOf(objective.extensions, criterion.id, "criterion") }) })),
      criteriaOpen: objective.criteriaOpen,
      extensionActive: objective.extensionActive,
      criteriaProposals: objective.criteriaProposals.map((proposal, index) => ({ n: index + 1, id: proposal.id, kind: proposal.kind,
        ...withoutEmpty({ target: proposal.target, targetN: proposal.target ? objective.criteria.findIndex((criterion) => criterion.id === proposal.target) + 1 : null, text: proposal.text, reason: proposal.reason, annotation: proposal.annotation, annotationBy: proposal.annotationBy }) })),
      // 구성원 id 가 곧 그 세션의 Operation id 다.
      members: objective.members.map((member) => ({ id: member.id, role: member.role, ...withoutEmpty({ brief: member.brief, model: member.model, effort: member.effort }), by: member.by, subagents: member.subagents, session: member.sessionName,
        state: ctx.host.operations.get(member.id) ? observe(member.id).state : "missing" as const })),
      done: !!objective.done, completedBy: objective.done?.by, awaitingHandoff: objective.awaitingHandoff, awaitingReview: objective.awaitingReview,
      handoff: objective.handoff ? { by: objective.handoff.by, at: new Date(objective.handoff.at).toISOString(), retrospective: objective.handoff.retrospective } : null,
      extensions: objective.extensions.map((round) => ({ ...round, at: new Date(round.at).toISOString(),
        previousHandoff: round.previousHandoff ? { ...round.previousHandoff, at: new Date(round.previousHandoff.at).toISOString() } : null })),
      addedBy: objective.addedBy,
      edited: objective.edited, actions: objective.actions, actionCounts: objective.actionCounts,
      removed: objective.removed, merged: objective.merged,
    }),
    graph: graph(objective),
    ...withoutEmpty({
      // 후속 후보 — 지휘관이 고치거나 거둘 수 있는 것은 open 뿐이다. 폐기 흔적은 제목·요약만.
      followups: objective.followups.map((candidate) => (candidate.state === "discarded"
        ? { id: candidate.id, state: candidate.state, title: candidate.title, summary: candidate.summary, discarded: candidate.discarded }
        : { id: candidate.id, rev: candidate.rev, state: candidate.state, title: candidate.title, summary: candidate.summary, userImpact: candidate.userImpact, fromMission: candidate.fromMission, brief: candidate.brief, criteria: candidate.criteria, evidence: candidate.evidence.map((entry) => withoutEmpty({ ...entry })) })),
      followupBatches: objective.followupBatches.map((batch) => ({ id: batch.id, by: batch.by ?? "human", at: new Date(batch.at).toISOString(), items: batch.items.map((entry) => ({ candidateId: entry.candidateId, title: entry.snapshot.title, state: entry.state, ...withoutEmpty({ operationId: entry.operationId, error: entry.error }) })) })),
      // 이 목표가 후속으로 태어났다면 — 원본과 발견 당시의 근거.
      origin: objective.origin,
      // 지금의 결정 요청 — 철회에 쓰는 id 와 지휘관이 낸 질문. 선택지 id 는 사람의 화면이 쓰는 값이다.
      decisionRequest: objective.decisionRequest ? { id: objective.decisionRequest.id, questions: objective.decisionRequest.questions.map((question) => ({ text: question.text,
        ...withoutEmpty({ options: question.options.map((option) => option.label), multiSelect: question.multiSelect, missionId: question.missionId, memberId: question.memberId }) })) } : null,
    }),
    decisionRequestRevision: objective.decisionRequestRevision,
    ...(objective.decisionDelivery ? { decisionDelivering: true } : {}),
    // 결정 — 사람이 보낸 답. 질문과 고른 선택지의 이름, 직접 쓴 말, 선택지를 모두 버린 내 의견 표시만 싣는다.
    ...withoutEmpty({ decisions: objective.decisions.map((decision) => ({ question: decision.question.text, by: decision.by ?? "human",
      ...withoutEmpty({
        selected: decision.answer.selectedOptionIds.flatMap((id) => decision.question.options.filter((option) => option.id === id).map((option) => option.label)),
        text: decision.answer.text, own: ownAnswer(decision.question, decision.answer), missionId: decision.missionId, memberId: decision.memberId,
      }),
      at: new Date(decision.at).toISOString() })) }),
  });
  /**
   * 목록 한 줄 — 상세를 열지 않고도 목표끼리 견줄 수 있게 한다. operation 은 지휘관 Operation 이 있는지다(보드에서 만들고
   * 아직 기동하지 않은 목표만 false).
   * 브리핑은 앞부분만 싣고, 잘렸으면 briefTruncated 로 알린다. 전문은 목표 하나를 읽는다.
   */
  const rowView = (objective: Objective) => ({
    id: objective.id, groupId: objective.groupId, title: objective.title,
    operation: !store.pending(objective.id),
    done: !!objective.done, completedBy: objective.done?.by, awaitingHandoff: objective.awaitingHandoff, awaitingReview: objective.awaitingReview, dueDate: objective.dueDate, today: objective.today, missions: `${objective.missions.filter((mission) => mission.done).length}/${objective.missions.length}`, mode: commanderMode(objective.missions), addedBy: objective.addedBy && "operationId" in objective.addedBy ? objective.addedBy.operationId : objective.addedBy,
    ...withoutEmpty({
      commenced: objective.commenced,
      // 에이전트가 지웠거나 합친 목표 — 목록에는 filter all 에서만 선다.
      removed: !!objective.removed,
      mergedInto: objective.removed?.mergedInto?.id ?? null,
      brief: objective.note.length > ROW_BRIEF ? `${objective.note.slice(0, ROW_BRIEF)}…` : objective.note,
      briefTruncated: objective.note.length > ROW_BRIEF,
      criteria: objective.criteria.map((criterion) => criterion.text),
    }),
  });
  /** 알림 문구의 언어 — 목표가 띄운 세션에 objectiveLanguage 로 남아 있다. */
  const languageOf = (caller: ConsoleCaller | undefined): PromptLanguage => {
    if (caller?.kind !== "operation") return "en";
    return ctx.host.operations.get(caller.operationId)?.payload?.objectiveLanguage === "ko" ? "ko" : "en";
  };
  const sessions = (objective: Objective) => {
    const commander = observe(objective.id);
    return {
      commander: { ...commander, state: store.pending(objective.id) ? "not_started" : commander.state, session: objective.commander.sessionName, model: objective.commander.model, effort: objective.commander.effort },
      members: objective.members.map((member) => ({ ...observe(member.id), role: member.role, session: member.sessionName, model: member.model, effort: member.effort, next: member.next })),
    };
  };
  const historyView = (objective: Objective) => {
    const handoffs = [...objective.extensions.flatMap((round) => round.previousHandoff ? [round.previousHandoff] : []),
      ...(objective.actions ?? []).flatMap((action) => action.handoff ? [action.handoff] : []), ...(objective.handoff ? [objective.handoff] : [])];
    const unique = [...new Map(handoffs.map((handoff) => [`${handoff.at}:${JSON.stringify(handoff.by)}`, handoff])).values()];
    return {
      ...rowView(objective), completed: objective.done, boardUpdatedAt: objective.boardUpdatedAt,
      handoffs: unique.map((handoff) => ({ ...handoff, at: new Date(handoff.at).toISOString() })),
      decisions: objective.decisions, extensions: objective.extensions,
      reopenCount: objective.actionCounts?.reopen ?? 0,
      rework: { steeringTurns: objective.actionCounts?.steer ?? 0, reopenedMissions: objective.actionCounts?.["mission-reopened"] ?? 0, extensionRounds: objective.extensions.length },
      actions: objective.actions ?? [], actionCounts: objective.actionCounts ?? {},
    };
  };
  return { objectiveView, rowView, languageOf, sessions, historyView };
}
