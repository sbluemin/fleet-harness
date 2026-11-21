import { createElement } from "react";
import { CommodoreGroupComposerSettings } from "../../commodore/client/commodore-conversation.js";
import { objectiveOpenUIPort } from "./openui-ports.js";
import type { ConversationConsultReply, ConversationMember, ConversationMessageVia, ConversationSpeaker, GroupConversationActions, GroupTimelineEntry, ObjectiveClusterConversation } from "../../execution/shared/conversation/types.js";
import { MAX_OBJECTIVE_ACTIONS, type ConsultationDeliveryState, type Objective, type ObjectiveAction, type ObjectiveActionKind } from "../shared/types.js";
import { commodoreAliasOf } from "./board-commodore.js";
import { objectivesEn, type ObjectiveMessageKey } from "./i18n/index.js";
import { localized } from "./launch-control.js";

/**
 * 명부 표식과 보드 행위·결정을 그룹 대화 계약으로 엮는다. 소유 사령관의 설정은 렌더 슬롯으로 제공한다.
 */
export function objectiveConversation(objective: Objective, toneAt: (index: number) => string, openRecord?: (at: number) => void, actions?: GroupConversationActions): ObjectiveClusterConversation {
  const alias = commodoreAliasOf(objective.commodoreId);
  const members: ConversationMember[] = objective.members.map((member, index) => ({ kind: "member", objectiveId: member.id, name: member.role, mark: { number: index + 1, tone: toneAt(index) } }));
  const events: GroupTimelineEntry[] = (objective.memberHistory ?? []).map((entry) => ({
    kind: entry.kind === "joined" ? "member-joined" : "member-left", id: `membership:${objective.id}:${entry.id}`, at: entry.at,
    speaker: { kind: "member", objectiveId: entry.memberId, name: entry.name, mark: { number: entry.number, tone: toneAt(entry.number - 1) } },
  }));
  const speaker: ConversationSpeaker = { kind: "commodore", name: "Commodore" };
  if (objective.addedBy && "kind" in objective.addedBy && objective.addedBy.kind === "commodore") events.push({
    kind: "board-action", id: `board:${objective.id}:added`, at: objective.createdAt, objectiveId: objective.id, speaker, action: boardAct("added"), text: objective.addedBy.why ?? objective.title,
  });
  // 사령관 행위 줄 — 줄만 보고도 무엇을 했는지 알게 행위의 내용(판정한 기준 문구)을 싣는다. 연달아 낸 같은 기준 판정은 한 줄로 묶는다.
  const history = objective.actions ?? [];
  for (let index = 0; index < history.length;) {
    const first = history[index]!;
    let end = index + 1;
    if (isCommodore(first.by) && CRITERIA_VERDICTS.has(first.kind)) {
      while (end < history.length && history[end]!.kind === first.kind && isCommodore(history[end]!.by) && history[end]!.at - history[end - 1]!.at <= VERDICT_RUN_MS) end++;
    }
    const run = history.slice(index, end);
    index = end;
    if (!isCommodore(first.by)) continue;
    const words = run.map(actionWords).filter((text) => text.length > 0);
    const voicedAs = VOICED_ACTS[first.kind];
    events.push({
      kind: "board-action", id: `board:${objective.id}:${first.id}`, at: first.at, objectiveId: objective.id, speaker,
      action: run.length > 1 ? localized((t) => t(`objectives.prov.act.${first.kind as "criteria-approved" | "criteria-rejected"}.count`, { count: run.length })) : boardAct(first.kind),
      text: run.length > 1 ? words.map((text) => `- ${text}`).join("\n") : words[0] ?? "",
      ...(voicedAs ? { voicedAs } : {}),
    });
  }
  // 사람이 답한 결정 — 요청 하나가 한 줄로, 답한 시각의 자리에 선다(질문 순서 그대로). 대화가 하단 카드 대신 이 줄을 기록으로 읽는다.
  const answered = new Map<string, Extract<GroupTimelineEntry, { kind: "decision-answer" }>>();
  for (const decision of objective.decisions) {
    const labels = decision.question.options.filter((option) => decision.answer.selectedOptionIds.includes(option.id)).map((option) => option.label);
    if (typeof decision.by === "object" && decision.by.kind === "commodore") {
      events.push({
        kind: "board-action", id: `board:${objective.id}:${decision.id}`, at: decision.at, objectiveId: objective.id, speaker, action: boardAct(decision.declined === true ? "decline" : "answer"),
        text: [decision.question.text, ...labels, decision.answer.text, decision.by.why].filter(Boolean).join("\n"),
      });
      continue;
    }
    const answer = { ...(decision.question.header ? { header: decision.question.header } : {}), question: decision.question.text, answer: [...labels, ...(decision.answer.text ? [decision.answer.text] : [])].join(", "), ...(decision.declined === true ? { declined: true as const } : {}) };
    const key = decision.requestId ?? decision.id;
    const entry = answered.get(key);
    answered.set(key, entry ? { ...entry, answers: [...entry.answers, answer] } : { kind: "decision-answer", id: `decision:${objective.id}:${key}`, at: decision.updatedAt ?? decision.at, answers: [answer] });
  }
  events.push(...answered.values());
  events.push(...consultationEvents(objective, speaker));
  const truncated = (objective.memberHistory?.length ?? 0) >= MAX_OBJECTIVE_ACTIONS || Object.values(objective.actionCounts ?? {}).reduce((sum, count) => sum + count, 0) > (objective.actions?.length ?? 0);
  // 사령관 행위 줄 → 그 시각의 사령관 기록(읽기 전용). 줄 id 로 시각을 찾는다 — 모르는 줄이면 아무 일도 없다.
  const openBoardAction = openRecord ? (entryId: string) => {
    const entry = events.find((event) => event.id === entryId && event.kind === "board-action");
    if (entry && entry.at !== null) openRecord(entry.at);
  } : undefined;
  const renderComposerControls: ObjectiveClusterConversation["renderComposerControls"] = (context) => createElement(CommodoreGroupComposerSettings, { commodoreId: objective.commodoreId, ...context });
  return {
    objectiveId: objective.id, openUIOpen: objectiveOpenUIPort(objective.theaterId, objective), recordedObjective: objective.recorded === true,
    ...(objective.recorded ? { renderComposerControls } : {}),
    commodoreAlias: alias, holds: [], members, decision: null,
    events, truncated, ...(actions ? { actions } : {}), ...(openBoardAction ? { openBoardAction } : {}),
  };
}

/**
 * 지휘관 자문 — 질문·답은 전언 줄(`자문 요청`/`자문 답변`)로 각자의 시각에 서고, 본문은 슬라이드 대화 창에서 읽는다. 사령관 대화도 같은 문법이다.
 */
export function consultationEvents(objective: Objective, commodore: ConversationSpeaker): GroupTimelineEntry[] {
  const commander: ConversationSpeaker = { kind: "commander", name: "commander", objectiveId: objective.id };
  return objective.consultations.flatMap((consult): GroupTimelineEntry[] => {
    const ask: GroupTimelineEntry = {
      kind: "delegation",
      id: `consult:${objective.id}:${consult.id}:ask`,
      at: consult.at,
      sender: commander,
      recipients: [commodore],
      text: consult.question,
      result: "",
      received: false,
      via: "consult",
    };
    if (!consult.reply) return [ask];
    return [ask, {
      kind: "delegation",
      id: `consult:${objective.id}:${consult.id}:reply`,
      at: consult.reply.at,
      sender: commodore,
      recipients: [commander],
      text: consult.reply.kind === "advice" ? consult.reply.text : "",
      result: "",
      received: true,
      via: "consult-reply",
      ...(consult.reply.kind === "no-additional-advice" ? { noAdvice: true as const } : {}),
    }];
  });
}

/** 보드의 알림 전달 상태를 사람이 읽는 세 상태로 — 보내는 중은 아직 닿지 않았다. 작업 중인 지휘관에게도 바로 가므로 대기는 입력·권한 대기 같은 때뿐이다. */
export function consultDelivery(state: ConsultationDeliveryState): NonNullable<ConversationConsultReply["delivery"]> {
  return state === "submitted" ? "delivered" : state === "uncertain" ? "uncertain" : "waiting";
}

const CRITERIA_VERDICTS: ReadonlySet<ObjectiveActionKind> = new Set(["criteria-approved", "criteria-rejected"]);
/** 「모두 승인」처럼 한 번에 낸 판정이 따로 기록돼도 한 판정으로 읽히는 간격. */
const VERDICT_RUN_MS = 60_000;
/** 덧붙인 말이 제 말풍선(`via`)으로 서는 행위 — 그 말풍선이 있으면 그룹 대화가 이 줄을 비켜 세운다. */
const VOICED_ACTS: Partial<Record<ObjectiveActionKind, ConversationMessageVia>> = { steer: "steer", commence: "start", plan: "plan" };

function isCommodore(by: ObjectiveAction["by"]): by is Extract<ObjectiveAction["by"], { kind: "commodore" }> {
  return typeof by === "object" && by.kind === "commodore";
}

/** 행위가 무엇이었는지의 글 — 기준 판정이면 그 기준 문구(폐기·재확인이면 사유), 그 밖에는 사령관이 단 근거. */
function actionWords(action: ObjectiveAction): string {
  const proposal = CRITERIA_VERDICTS.has(action.kind) ? action.proposal : undefined;
  const words = proposal?.text ?? proposal?.reason ?? (isCommodore(action.by) ? action.by.why : undefined) ?? "";
  return words.trim();
}

function boardAct(kind: string) {
  return localized((t) => {
    const key = `objectives.prov.act.${kind}`;
    return key in objectivesEn ? t(key as ObjectiveMessageKey) : kind;
  });
}
