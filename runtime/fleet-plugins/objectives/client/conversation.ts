import type { ConversationMember, ConversationMemberProfile, ConversationSpeaker, GroupConversationActions, GroupTimelineEntry, OperationClusterConversation } from "@fleet-console/sdk/conversation";
import type { Translate } from "@fleet-console/sdk/i18n";
import type { ModelRoster } from "@fleet-console/sdk/models";
import { MAX_OBJECTIVE_ACTIONS, type Objective, type ObjectiveMember } from "../server/types.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { commanderLaunchShown, localized, memberFallbackNote, memberLaunched, memberLaunchShown, memberRoutedTag, memberStatus, type LaunchShown } from "./launch-control.js";

/** 명부 줄의 보드 사실을 셀 재료 — 구성원 Operation 의 화면 활동(백그라운드를 작업 중으로 접은 값, 없으면 "closed")과 기동 로스터. */
export interface ConversationCrew {
  readonly state: (operationId: string) => string;
  readonly roster: ModelRoster | null;
}

/** Console에는 구현 컴포넌트 대신 명부 표식과 보드 사실만 건넨다. 보드 사실의 글은 보드 행과 같은 함수가 같은 값으로 짓는다. */
export function objectiveConversation(objective: Objective, toneAt: (index: number) => string, open: () => void, openRecord?: (at: number) => void, actions?: GroupConversationActions, crew?: ConversationCrew): OperationClusterConversation {
  const members: ConversationMember[] = objective.members.map((member, index) => ({ kind: "member", operationId: member.id, name: member.role, mark: { number: index + 1, tone: toneAt(index) }, ...(crew ? { profile: memberProfile(objective, member, crew) } : {}) }));
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
  // 사령관 행위 줄 → 그 시각의 사령관 기록(읽기 전용). 줄 id 로 시각을 찾는다 — 모르는 줄이면 아무 일도 없다.
  const openBoardAction = openRecord ? (entryId: string) => {
    const entry = events.find((event) => event.id === entryId && event.kind === "board-action");
    if (entry && entry.at !== null) openRecord(entry.at);
  } : undefined;
  return { operationId: objective.id, members, ...(crew ? { commander: commanderProfile(objective, crew.roster) } : {}), events, truncated, ...(actions ? { actions } : {}), ...(openBoardAction ? { openBoardAction } : {}), decision: request ? {
    id: request.id, title: request.questions[0]?.text ?? objective.title, createdAt: request.createdAt,
    questions: request.questions.map((question) => ({ id: question.id, text: question.text, multiSelect: question.multiSelect, options: question.options })), open,
    ...(actions ? { answer: (answers) => actions.answerDecision(request.id, answers) } : {}),
  } : null };
}

/** 보드 구성원 행이 보이는 것 — 역할 곁 제안 표식, 브리프, 모델·강도(라우팅 표식·꺼짐 포함), 상태 낱말, 폴백 사유. 로케일과 무관한 칸은 한 번만 센다. */
function memberProfile(objective: Objective, member: ObjectiveMember, crew: ConversationCrew): ConversationMemberProfile {
  const state = crew.state(member.id);
  const launched = memberLaunched(member, crew.state);
  const en = getT("en");
  const { failed } = memberStatus(member, state, objective, en);
  const routed = memberRoutedTag(member, launched, en);
  const note = memberFallbackNote(member, launched, en);
  return {
    ...(member.by === "commander" ? { badge: localized((t) => t("objectives.members.proposed")) } : {}),
    ...(member.brief ? { brief: member.brief } : {}),
    launch: {
      ...launchLine((t) => memberLaunchShown(member, launched, t, crew.roster)),
      ...(routed ? { via: { label: localized((t) => memberRoutedTag(member, launched, t)!.label), title: localized((t) => memberRoutedTag(member, launched, t)!.title), ...(routed.via === "fallback" ? { tone: "warn" as const } : {}) } } : {}),
    },
    status: { text: localized((t) => memberStatus(member, state, objective, t).text), ...(failed ? { tone: "danger" as const } : {}) },
    ...(note ? { note: { text: localized((t) => memberFallbackNote(member, launched, t)!.text), ...(note.title !== undefined ? { title: note.title } : {}), tone: "warn" as const } } : {}),
  };
}

/** 보드의 지휘관 행은 모델·강도만 보인다 — 그 한 줄만 싣는다. */
function commanderProfile(objective: Objective, roster: ModelRoster | null): ConversationMemberProfile {
  return { launch: launchLine((t) => commanderLaunchShown(objective, t, roster)) };
}

/** 트리거 낱말 한 줄을 계약의 모양으로 — 글은 로케일마다 다시 풀고, 글리프·취소선은 한 번만 센다. */
function launchLine(shown: (t: Translate<ObjectiveMessageKey>) => LaunchShown): NonNullable<ConversationMemberProfile["launch"]> {
  const { provider, struck, badge } = shown(getT("en"));
  return {
    label: localized((t) => shown(t).label),
    title: localized((t) => shown(t).title),
    ...(provider ? { provider } : {}),
    ...(struck ? { struck } : {}),
    ...(badge !== null ? { badge: localized((t) => shown(t).badge ?? "") } : {}),
  };
}
