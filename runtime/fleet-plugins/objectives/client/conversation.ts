import type { ConversationHold, ConversationMember, ConversationMemberProfile, ConversationSpeaker, GroupConversationActions, GroupTimelineEntry, OperationClusterConversation } from "@fleet-console/sdk/conversation";
import type { Translate } from "@fleet-console/sdk/i18n";
import type { ModelRoster } from "@fleet-console/sdk/models";
import { livePersonHold } from "../server/board-state.js";
import { MAX_DECISION_ANSWER_INPUT, MAX_OBJECTIVE_ACTIONS, type Objective, type ObjectiveMember } from "../server/types.js";
import { decisionTurn } from "./commodore-state.js";
import { getT, objectivesEn, type ObjectiveMessageKey } from "./i18n/index.js";
import { openObjectiveFromCluster, patchObjectiveView, returnPersonHold, revealObjective } from "./objectives-state.js";
import { followupPickable } from "./board-actions.js";
import { followupHoldRoute, openFollowups, setFollowupOpen } from "./followups.js";
import { commanderLaunchShown, localized, memberLaunched, memberLaunchShown, memberNotes, memberRoutedTag, memberStatus, type LaunchShown } from "./launch-control.js";

/** 명부 줄의 보드 사실을 셀 재료 — 구성원 Operation 의 화면 활동(백그라운드를 작업 중으로 접은 값, 없으면 "closed")과 기동 로스터. */
export interface ConversationCrew {
  readonly state: (operationId: string) => string;
  readonly roster: ModelRoster | null;
}

/**
 * Console에는 구현 컴포넌트 대신 명부 표식과 보드 사실만 건넨다. 보드 사실의 글은 보드 행과 같은 함수가 같은 값으로 짓는다.
 * `commodoreActive` — 이 Theater 의 자율 운영이 실제로 도는가. 결정 카드의 차례(사령관이 답하는 중·넘긴 이유)를 정한다.
 */
export interface ObjectiveConversationViewPorts {
  readonly returnPersonHold: typeof returnPersonHold;
  readonly revealCriteria: (objective: Objective) => void;
  readonly followupPickable: typeof followupPickable;
  readonly setFollowupOpen: typeof setFollowupOpen;
}
const localViewPorts: ObjectiveConversationViewPorts = {
  returnPersonHold, followupPickable, setFollowupOpen,
  revealCriteria: (objective) => {
    patchObjectiveView(objective.theaterId, () => ({ detailTab: "goal" }));
    revealObjective({ objectiveId: objective.id });
    openObjectiveFromCluster(objective.theaterId);
  },
};
export function objectiveConversation(objective: Objective, toneAt: (index: number) => string, open: () => void, openRecord?: (at: number) => void, actions?: GroupConversationActions, crew?: ConversationCrew, commodoreActive = false, ports: ObjectiveConversationViewPorts = localViewPorts): OperationClusterConversation {
  const members: ConversationMember[] = objective.members.map((member, index) => ({ kind: "member", operationId: member.id, name: member.role, mark: { number: index + 1, tone: toneAt(index) }, ...(crew ? { profile: memberProfile(objective, member, crew) } : {}) }));
  const events: GroupTimelineEntry[] = (objective.memberHistory ?? []).map((entry) => ({
    kind: entry.kind === "joined" ? "member-joined" : "member-left", id: `membership:${objective.id}:${entry.id}`, at: entry.at,
    speaker: { kind: "member", operationId: entry.memberId, name: entry.name, mark: { number: entry.number, tone: toneAt(entry.number - 1) } },
  }));
  const speaker: ConversationSpeaker = { kind: "commodore", name: "Commodore" };
  if (objective.addedBy && "kind" in objective.addedBy && objective.addedBy.kind === "commodore") events.push({
    kind: "board-action", id: `board:${objective.id}:added`, at: objective.createdAt, objectiveId: objective.id, speaker, action: boardAct("added"), text: objective.addedBy.why ?? objective.title,
  });
  for (const action of objective.actions ?? []) if (typeof action.by === "object" && action.by.kind === "commodore") events.push({
    kind: "board-action", id: `board:${objective.id}:${action.id}`, at: action.at, objectiveId: objective.id, speaker, action: boardAct(action.kind), text: action.by.why ?? "",
  });
  // 사람이 답한 결정 — 요청 하나가 한 줄로, 답한 시각의 자리에 선다(질문 순서 그대로). 대화가 하단 카드 대신 이 줄을 기록으로 읽는다.
  const answered = new Map<string, Extract<GroupTimelineEntry, { kind: "decision-answer" }>>();
  for (const decision of objective.decisions) {
    const labels = decision.question.options.filter((option) => decision.answer.selectedOptionIds.includes(option.id)).map((option) => option.label);
    if (typeof decision.by === "object" && decision.by.kind === "commodore") {
      events.push({
        kind: "board-action", id: `board:${objective.id}:${decision.id}`, at: decision.at, objectiveId: objective.id, speaker, action: boardAct("answer"),
        text: [decision.question.text, ...labels, decision.answer.text, decision.by.why].filter(Boolean).join("\n"),
      });
      continue;
    }
    const answer = { ...(decision.question.header ? { header: decision.question.header } : {}), question: decision.question.text, answer: [...labels, ...(decision.answer.text ? [decision.answer.text] : [])].join(", ") };
    const entry = answered.get(decision.requestId);
    answered.set(decision.requestId, entry ? { ...entry, answers: [...entry.answers, answer] } : { kind: "decision-answer", id: `decision:${objective.id}:${decision.requestId}`, at: decision.at, answers: [answer] });
  }
  events.push(...answered.values());
  const request = !objective.done ? objective.decisionRequest : null;
  // 결정 카드의 차례 — 사령관이 넘긴 요청이면 넘긴 이유와 돌려주기, 사령관이 맡은 요청이면 「답하는 중」. 답이 갈 곳은 늘 한 줄.
  const handedHold = request ? livePersonHold(objective, "decision") : null;
  const handler = request && decisionTurn(objective, commodoreActive) === "commodore";
  const truncated = (objective.memberHistory?.length ?? 0) >= MAX_OBJECTIVE_ACTIONS || Object.values(objective.actionCounts ?? {}).reduce((sum, count) => sum + count, 0) > (objective.actions?.length ?? 0);
  // 사령관 행위 줄 → 그 시각의 사령관 기록(읽기 전용). 줄 id 로 시각을 찾는다 — 모르는 줄이면 아무 일도 없다.
  const openBoardAction = openRecord ? (entryId: string) => {
    const entry = events.find((event) => event.id === entryId && event.kind === "board-action");
    if (entry && entry.at !== null) openRecord(entry.at);
  } : undefined;
  return { operationId: objective.id, holds: conversationHolds(objective, ports), members, ...(crew ? { commander: commanderProfile(objective, crew.roster) } : {}), events, truncated, ...(actions ? { actions } : {}), ...(openBoardAction ? { openBoardAction } : {}), decision: request ? {
    id: request.id, title: request.questions[0]?.text ?? objective.title, createdAt: request.createdAt,
    questions: request.questions.map((question) => ({ id: question.id, ...(question.header ? { header: question.header } : {}), text: question.text, multiSelect: question.multiSelect, options: question.options })),
    answerMaxLength: MAX_DECISION_ANSWER_INPUT, open,
    ...(actions ? { answer: (answers) => actions.answerDecision(request.id, answers) } : {}),
    ...(handler ? { handler: localized((t) => t("objectives.commodore.note.answering")) } : {}),
    ...(handedHold ? { handed: {
      label: localized((t) => t("objectives.decision.handed")), reason: handedHold.reason,
      giveBack: { label: localized((t) => t("objectives.decision.giveBack")), run: () => ports.returnPersonHold(objective.id, "decision") },
    } } : {}),
    route: localized((t) => t(handedHold ? "objectives.decision.routeHanded" : "objectives.decision.route")),
  } : null };
}

function boardAct(kind: string) {
  return localized((t) => {
    const key = `objectives.prov.act.${kind}`;
    return key in objectivesEn ? t(key as ObjectiveMessageKey) : kind;
  });
}

/** 대화에 세울 넘김 대상은 이 한 곳에서 정한다. 결정 요청은 자체 카드의 handed 를 쓴다. */
const HOLD_TARGETS = ["criteria", "review", "followup"] as const;

function conversationHolds(objective: Objective, ports: ObjectiveConversationViewPorts): readonly ConversationHold[] {
  return HOLD_TARGETS.flatMap((target): ConversationHold[] => {
    const hold = livePersonHold(objective, target);
    if (!hold) return [];
    const pickable = target === "followup" && ports.followupPickable(objective);
    const routeKey: ObjectiveMessageKey = target === "criteria" ? "objectives.hold.route.criteria"
      : target === "review" ? "objectives.hold.route.review"
        : pickable && !objective.done ? "objectives.followup.sub"
          : followupHoldRoute(objective);
    const reveal = target === "criteria"
      ? { label: localized((t) => t("objectives.composer.reveal")), run: () => ports.revealCriteria(objective) }
      : pickable ? { label: localized((t) => t("objectives.hold.pick")), run: () => ports.setFollowupOpen(objective.id, true) } : undefined;
    return [{
      id: `hold:${objective.id}:${target}:${hold.at}`,
      title: localized((t) => t(target === "criteria" ? "objectives.criteria.title" : target === "review" ? "objectives.objectives.review" : "objectives.followup.title")),
      createdAt: hold.at,
      handed: {
        label: localized((t) => t("objectives.decision.handed")), reason: hold.reason,
        giveBack: { label: localized((t) => t("objectives.decision.giveBack")), run: () => ports.returnPersonHold(objective.id, target) },
      },
      route: localized((t) => t(routeKey, { n: openFollowups(objective).length })),
      ...(reveal ? { reveal } : {}),
    }];
  }).sort((a, b) => a.createdAt - b.createdAt);
}

/** 보드 구성원 행이 보이는 것 — 역할 곁 제안 표식, 브리프, 모델·강도(라우팅 표식·꺼짐 포함), 상태 낱말, 폴백 사유. 로케일과 무관한 칸은 한 번만 센다. */
function memberProfile(objective: Objective, member: ObjectiveMember, crew: ConversationCrew): ConversationMemberProfile {
  const state = crew.state(member.id);
  const launched = memberLaunched(member, crew.state);
  const en = getT("en");
  const { failed } = memberStatus(member, state, objective, en);
  const routed = memberRoutedTag(member, launched, en);
  const notes = memberNotes(member, launched, en);
  return {
    ...(member.by === "commander" ? { badge: localized((t) => t("objectives.members.proposed")) } : {}),
    ...(member.brief ? { brief: member.brief } : {}),
    launch: {
      ...launchLine((t) => memberLaunchShown(member, launched, t, crew.roster)),
      ...(routed ? { via: { label: localized((t) => memberRoutedTag(member, launched, t)!.label), title: localized((t) => memberRoutedTag(member, launched, t)!.title), ...(routed.via === "fallback" ? { tone: "warn" as const } : {}) } } : {}),
    },
    status: { text: localized((t) => memberStatus(member, state, objective, t).text), ...(failed ? { tone: "danger" as const } : {}) },
    // 진단 줄의 개수·순서·tone·원문은 로케일과 무관하다 — 낱말만 로케일마다 다시 푼다.
    ...(notes.length > 0 ? { notes: notes.map((note, index) => ({ text: localized((t) => memberNotes(member, launched, t)[index]?.text ?? ""), ...(note.title !== undefined ? { title: note.title } : {}), tone: note.tone })) } : {}),
  };
}

/** 보드의 지휘관 행은 모델·강도만 보인다 — 그 한 줄만 싣는다. */
function commanderProfile(objective: Objective, roster: ModelRoster | null): ConversationMemberProfile {
  return { launch: launchLine((t) => commanderLaunchShown(objective, t, roster)) };
}

/** 트리거 낱말 한 줄을 계약의 모양으로 — 글은 로케일마다 다시 풀고, 글리프·취소선은 한 번만 센다. */
function launchLine(shown: (t: Translate<ObjectiveMessageKey>) => LaunchShown): NonNullable<ConversationMemberProfile["launch"]> {
  const { provider, struck, badge, effort } = shown(getT("en"));
  return {
    label: localized((t) => shown(t).label),
    ...(effort !== null ? { effort: localized((t) => shown(t).effort ?? "") } : {}),
    title: localized((t) => shown(t).title),
    ...(provider ? { provider } : {}),
    ...(struck ? { struck } : {}),
    ...(badge !== null ? { badge: localized((t) => shown(t).badge ?? "") } : {}),
  };
}
