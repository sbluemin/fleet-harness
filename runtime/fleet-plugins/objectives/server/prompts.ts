import type { ObjectiveEditKind, ObjectiveItem } from "./types.js";

/**
 * 프롬프트 — 지휘관에게 가는 사람의 말 한 줄뿐이다. 시스템 지침은 없다: 지휘관은 `fleet-objectives` 도구 설명과 보드를 읽고
 * 스스로 흐름을 잡는다. 담당 세션에는 아무 프롬프트도 가지 않는다 — 지휘관이 SendMessage 로 맥락을 담아 일을 시킨다.
 */

export type PromptLanguage = "en" | "ko";

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);


/**
 * 구상 — 한 줄: 목표 id 와 「구상」. 편성은 보드에 올리고(plan·place_mission) 임무는 수행하지 않는다 — 「계획만」을 보드에
 * 쓰지 말라는 뜻으로 읽으면 사람이 개시 전에 계획을 보지 못한다. 사람이 함께 준 맥락이 있으면 그 아래 인용으로.
 */
export function cookTurn(item: ObjectiveItem, language: PromptLanguage): string {
  const context = item.cook?.trim();
  const word = language === "ko"
    ? `목표 \`${item.id}\` 을 구상하세요 — 편성(구성원·임무·선행·담당)을 보드에 올리고, 임무는 수행하지 마세요.`
    : `Plan objective \`${item.id}\` — lay the lineup (members, missions, prerequisites and assignments) out on the board; do not carry out any mission.`;
  return context ? `${word}\n\n> ${clip(context, 2000).split("\n").join("\n> ")}` : word;
}

const EDIT_WORDS: Record<PromptLanguage, Record<ObjectiveEditKind, string>> = {
  ko: { title: "제목", note: "브리핑", steps: "임무", recipe: "선행 관계", members: "구성원", assign: "배정", criteria: "달성 기준" },
  en: { title: "title", note: "brief", steps: "missions", recipe: "dependencies", members: "members", assign: "assignment", criteria: "success criteria" },
};

const editedWords = (item: ObjectiveItem, language: PromptLanguage): string => (item.edited?.kinds ?? []).map((kind) => EDIT_WORDS[language][kind]).join(language === "ko" ? "·" : ", ");

/**
 * 스티어링 — 지휘관이 일하는 동안이나 검토 대기 중에 사람이 보드를 고쳤다. 한 줄: 목표 id 가 바뀌었다는 것과 무엇이 바뀌었는지(종류만).
 * 바뀐 내용 자체(미분류 단계 등)는 보드가 말한다.
 */
export function steerTurn(item: ObjectiveItem, language: PromptLanguage): string {
  const what = editedWords(item, language);
  return language === "ko"
    ? `목표 \`${item.id}\` 이 바뀌었습니다${what ? `(${what})` : ""} — 보드를 다시 읽고 이어서 진행하세요.`
    : `Objective \`${item.id}\` changed${what ? ` (${what})` : ""} — read the board again and continue.`;
}

/**
 * 개시 — 한 줄: 목표 id 와 「임무를 개시하세요」. 무엇을 어떻게 할지는 지휘관이 정한다.
 * 지휘관이 마지막으로 읽은 뒤 사람이 바꾼 것이 있으면 무엇이 바뀌었는지만 짧게 붙이고 다시 읽게 한다 — 바뀐 내용 자체는 보드가 말한다.
 */
export function startTurn(item: ObjectiveItem, language: PromptLanguage): string {
  const word = language === "ko" ? `목표 \`${item.id}\` 의 임무를 개시하세요.` : `Commence the missions of objective \`${item.id}\`.`;
  const what = editedWords(item, language);
  if (!what) return word;
  return language === "ko"
    ? `${word}\n\n마지막으로 읽은 뒤 사람이 목표를 바꿨습니다(${what}). 진행하기 전에 \`fleet-objectives\` 로 이 목표를 다시 읽으세요.`
    : `${word}\n\nThe person changed this objective since you last read it (${what}). Read it again with \`fleet-objectives\` before you proceed.`;
}
