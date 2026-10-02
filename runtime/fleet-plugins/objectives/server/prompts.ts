import { MAX_CONTEXT, ownAnswer, type DecisionAnswer, type DecisionRequest, type ObjectiveEditKind, type Objective } from "./types.js";

/**
 * 프롬프트 — 지휘관에게 가는 사람의 말 한 줄뿐이다. 시스템 지침은 없다: 지휘관은 `fleet-objectives` 도구 설명과 보드를 읽고
 * 스스로 흐름을 잡는다. 담당 세션에는 아무 프롬프트도 가지 않는다 — 지휘관이 SendMessage 로 맥락을 담아 일을 시킨다.
 * 사람이 덧붙인 말이 있으면 그 한 줄 아래 인용으로 붙는다(구상·개시·스티어링 모두 같은 모양).
 */

export type PromptLanguage = "en" | "ko";

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** 사람이 덧붙인 말 — 비어 있으면 아무것도 붙지 않는다. */
const quoted = (context: string | undefined): string => {
  const text = context?.trim();
  return text ? `\n\n> ${clip(text, MAX_CONTEXT).split("\n").join("\n> ")}` : "";
};

/**
 * 채팅 원장에 설 문면 — 프롬프트는 숨기고 사람이 덧붙인 말만 보인다(없으면 빈 문자열, 출처 줄만 선다).
 * 프롬프트에 붙은 인용 그대로라 프롬프트의 부분 문자열이다. 호스트는 그 구간을 기억해 세션을 다시 연 뒤에도 같은 문면을 세운다.
 */
export const humanWords = (context: string | undefined): string => quoted(context).trimStart();

/**
 * 구상 — 한 줄: 목표 id 와 「구상」. 편성은 보드에 올리고(plan·place_mission) 임무는 수행하지 않는다 — 「계획만」을 보드에
 * 쓰지 말라는 뜻으로 읽으면 사람이 개시 전에 계획을 보지 못한다. 사람이 함께 준 맥락이 있으면 그 아래 인용으로.
 */
export function planTurn(objective: Objective, language: PromptLanguage): string {
  const word = language === "ko"
    ? `목표 \`${objective.id}\` 을 구상하세요 — 편성(구성원·임무·선행·담당)을 보드에 올리고, 임무는 수행하지 마세요.`
    : `Plan objective \`${objective.id}\` — lay the lineup (members, missions, prerequisites and assignments) out on the board; do not carry out any mission.`;
  const annotated = objective.criteriaProposals.filter((proposal) => !!proposal.annotation).length;
  const notice = annotated ? (language === "ko" ? ` 제안 ${annotated}건에 사람의 어노테이션이 있습니다 — 보드에서 읽으세요.` : ` ${annotated} proposals have the person's annotations — read them on the board.`) : "";
  const round = objective.extensionActive ? objective.extensions.at(-1) : undefined;
  const extension = !round ? "" : language === "ko"
    ? ` 확장 ${round.n} 회차입니다 — 끝난 임무와 기존 기준은 두고 더할 것만 구상하세요. 충족한 옛 기준을 다시 확인해야 하면 criteria에 {recheck: 기준 번호 또는 id, reason}으로 제안하세요. 사람이 승인한 기준만 충족 표시가 풀립니다.`
    : ` This is extension ${round.n} — keep finished missions and existing criteria and plan only the added scope. Propose any old met criterion that needs rechecking in criteria with {recheck: criterion number or id, reason}; only the person's approval clears its met evidence.`;
  const request = quoted(round?.context ?? objective.planRequest);
  const replanning = round && objective.planRequest?.trim() && objective.planRequest.trim() !== round.context ? quoted(objective.planRequest) : "";
  return `${word}${extension}${notice}${request}${replanning}`;
}

const EDIT_WORDS: Record<PromptLanguage, Record<ObjectiveEditKind, string>> = {
  ko: { title: "제목", note: "브리핑", missions: "임무", lineup: "선행 관계", members: "구성원", member: "배정", criteria: "달성 기준" },
  en: { title: "title", note: "brief", missions: "missions", lineup: "dependencies", members: "members", member: "assignment", criteria: "success criteria" },
};

const editedWords = (objective: Objective, language: PromptLanguage): string => (objective.edited?.kinds ?? []).map((kind) => EDIT_WORDS[language][kind]).join(language === "ko" ? "·" : ", ");

/**
 * 스티어링 — 지휘관이 일하는 동안이나 검토 대기 중에 사람이 보드를 고쳤다. 한 줄: 목표 id 가 바뀌었다는 것과 무엇이 바뀌었는지(종류만).
 * 바뀐 내용 자체(미분류 임무 등)는 보드가 말한다. 바뀐 것 없이 말만 왔으면 말을 덧붙였다고만 한다.
 */
export function steerTurn(objective: Objective, language: PromptLanguage, context?: string): string {
  const what = editedWords(objective, language);
  const note = quoted(context);
  const word = !what && note
    ? (language === "ko" ? `사람이 목표 \`${objective.id}\` 에 말을 덧붙였습니다 — 보드를 다시 읽고 이어서 진행하세요.` : `The person added a note to objective \`${objective.id}\` — read the board again and continue.`)
    : language === "ko"
      ? `목표 \`${objective.id}\` 이 바뀌었습니다${what ? `(${what})` : ""} — 보드를 다시 읽고 이어서 진행하세요.`
      : `Objective \`${objective.id}\` changed${what ? ` (${what})` : ""} — read the board again and continue.`;
  return `${word}${note}`;
}

/**
 * 사람이 구성원에게 직접 한 말 — 구성원에게는 말 그대로 가고, 지휘관에게는 누구에게 말했는지 한 줄과 그 말의 인용이 간다.
 * 무엇을 할지는 지휘관이 정한다.
 */
export function memberMessageTurn(objective: Objective, role: string, text: string, language: PromptLanguage): string {
  const word = language === "ko"
    ? `사람이 목표 \`${objective.id}\` 의 구성원 「${role}」 에게 직접 말했습니다.`
    : `The person spoke directly to member "${role}" of objective \`${objective.id}\`.`;
  return `${word}${quoted(text)}`;
}

/**
 * 개시 — 한 줄: 목표 id 와 「임무를 개시하세요」. 무엇을 어떻게 할지는 지휘관이 정한다.
 * 지휘관이 마지막으로 읽은 뒤 사람이 바꾼 것이 있으면 무엇이 바뀌었는지만 짧게 붙이고 다시 읽게 한다 — 바뀐 내용 자체는 보드가 말한다.
 */
export function startTurn(objective: Objective, language: PromptLanguage, context?: string): string {
  const word = language === "ko" ? `목표 \`${objective.id}\` 의 임무를 개시하세요.` : `Commence the missions of objective \`${objective.id}\`.`;
  const what = editedWords(objective, language);
  const changed = !what ? "" : language === "ko"
    ? `\n\n마지막으로 읽은 뒤 사람이 목표를 바꿨습니다(${what}). 진행하기 전에 \`fleet-objectives\` 로 이 목표를 다시 읽으세요.`
    : `\n\nThe person changed this objective since you last read it (${what}). Read it again with \`fleet-objectives\` before you proceed.`;
  return `${word}${changed}${quoted(context)}`;
}

/**
 * 결정 답 — 사람이 보드에서 결정 요청에 답했다. 요청 id 와 질문·고른 선택지(설명 포함)·직접 쓴 말을 원문 그대로 싣는다(자르지
 * 않는다). 결정 기록은 이 메시지가 닿은 뒤에 확정되므로 기록이 남았다고 말하지 않는다. 답의 뜻과 다음 일은 지휘관이 읽는다.
 */
export function decisionTurn(objective: Objective, request: DecisionRequest, answers: readonly DecisionAnswer[], language: PromptLanguage): string {
  const ko = language === "ko";
  const quote = (value: string) => `> ${value.split("\n").join("\n> ")}`;
  const blocks = request.questions.map((question, index) => {
    const answer = answers.find((entry) => entry.questionId === question.id);
    const picked = question.options.filter((option) => answer?.selectedOptionIds.includes(option.id)).map((option) => quote(option.description ? `${option.label} — ${option.description}` : option.label));
    const lines = [`${index + 1}. ${quote(question.text)}`];
    if (picked.length) lines.push(`${ko ? "고른 것" : "Chosen"}:\n${picked.join("\n")}`);
    // 고른 것에 붙인 말, 선택지를 모두 버린 내 의견, 선택지가 없는 질문의 답을 이름으로 가른다.
    const label = picked.length ? (ko ? "덧붙인 말" : "Added") : answer && ownAnswer(question, answer) ? (ko ? "선택지 대신 내 의견" : "Own answer instead of the options") : (ko ? "직접 쓴 말" : "Written");
    if (answer?.text.trim()) lines.push(`${label}:\n${quote(answer.text)}`);
    return lines.join("\n");
  });
  const head = ko
    ? `사람이 목표 \`${objective.id}\` 의 결정 요청 \`${request.id}\` 에 답했습니다. 아래는 해당 질문과 사람이 제출한 답입니다.`
    : `The person answered decision request \`${request.id}\` on objective \`${objective.id}\`. The questions and the person's submitted answers follow.`;
  return `${head}\n\n${blocks.join("\n\n")}`;
}

/**
 * 서브에이전트(Agent 도구) 호출이 받는 거절 사유 — 그 호출의 결과 자리에 서는 사실 한 줄이다. 모든 에이전트 Operation 은 자기 목표의
 * 지휘관이므로 서브에이전트 대신 그 목표의 구성원이 일손이다. 절차는 쓰지 않는다: 도구 설명이 말하고 흐름은 모델이 잡는다.
 * 구성원 세션은 관여하지 않는다(null) — 그 세션의 서브에이전트는 사람이 고른 허용값(subagents)이 정하고, 막힌 세션에는 도구가 없다.
 */
export function agentCallRedirect(objective: Objective | null, isMember: boolean): string | null {
  if (isMember || !objective) return null;
  if (objective.done) return `Subagents are not available in Fleet Console, and objective ${objective.id} is complete, so it takes no members. This Agent call did not run.`;
  return `Subagents are not available in Fleet Console; members of objective ${objective.id} take their place through the fleet-objectives tools, and a member is reached by SendMessage. This Agent call did not run.`;
}
