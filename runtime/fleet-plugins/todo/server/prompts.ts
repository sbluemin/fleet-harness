import { stepReady, type TodoEditKind, type TodoItem, type TodoStep } from "./types.js";

/**
 * 프롬프트 — 셰프에게 가는 사람의 말 한 줄뿐이다. 시스템 지침은 없다: 셰프는 `console_todo` 도구 설명과 보드를 읽고
 * 스스로 흐름을 잡는다. 담당 세션에는 아무 프롬프트도 가지 않는다 — 셰프가 SendMessage 로 맥락을 담아 일을 시킨다.
 */

export type PromptLanguage = "en" | "ko";

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** 세션 이름 — 다른 세션이 이 세션을 부르는 주소. 항목 id 앞 여섯 글자로 항목을 가른다. */
export const sessionNames = (item: TodoItem) => {
  const head = `todo-${item.id.slice(0, 6)}`;
  return { coordinator: `${head}-chef`, step: (index: number) => `${head}-step-${index}` };
};

export function readySteps(item: TodoItem): readonly TodoStep[] {
  return item.steps.filter((step) => !step.done && stepReady(item, step));
}

/** 쿠킹 — 한 줄: 할 일 id 와 「쿠킹」. 사람이 함께 준 맥락이 있으면 그 아래 인용으로. */
export function cookTurn(item: TodoItem, language: PromptLanguage): string {
  const context = item.cook?.trim();
  const word = language === "ko" ? `할 일 \`${item.id}\` 을 쿠킹하세요 — 계획만, 수행은 하지 마세요.` : `Cook to-do item \`${item.id}\` — plan only, do not perform it.`;
  return context ? `${word}\n\n> ${clip(context, 2000).split("\n").join("\n> ")}` : word;
}

const EDIT_WORDS: Record<PromptLanguage, Record<TodoEditKind, string>> = {
  ko: { title: "제목", note: "메모", steps: "단계", recipe: "선행 관계", assign: "배정" },
  en: { title: "title", note: "note", steps: "steps", recipe: "dependencies", assign: "assignment" },
};

const editedWords = (item: TodoItem, language: PromptLanguage): string => (item.edited?.kinds ?? []).map((kind) => EDIT_WORDS[language][kind]).join(language === "ko" ? "·" : ", ");

/**
 * 스티어링 — 셰프가 일하는 동안이나 검토 대기 중에 사람이 보드를 고쳤다. 한 줄: 할 일 id 가 바뀌었다는 것과 무엇이 바뀌었는지(종류만).
 * 바뀐 내용 자체(미분류 단계 등)는 보드가 말한다.
 */
export function steerTurn(item: TodoItem, language: PromptLanguage): string {
  const what = editedWords(item, language);
  return language === "ko"
    ? `할 일 \`${item.id}\` 이 바뀌었습니다${what ? `(${what})` : ""} — 보드를 다시 읽고 이어서 진행하세요.`
    : `To-do item \`${item.id}\` changed${what ? ` (${what})` : ""} — read the board again and continue.`;
}

/**
 * 시작 — 한 줄: 할 일 id 와 「진행하세요」. 무엇을 어떻게 할지는 셰프가 정한다.
 * 셰프가 마지막으로 읽은 뒤 사람이 바꾼 것이 있으면 무엇이 바뀌었는지만 짧게 붙이고 다시 읽게 한다 — 바뀐 내용 자체는 보드가 말한다.
 */
export function startTurn(item: TodoItem, language: PromptLanguage): string {
  const word = language === "ko" ? `할 일 \`${item.id}\` 의 작업들을 진행하세요.` : `Proceed with the work of to-do item \`${item.id}\`.`;
  const what = editedWords(item, language);
  if (!what) return word;
  return language === "ko"
    ? `${word}\n\n마지막으로 읽은 뒤 사람이 할 일을 바꿨습니다(${what}). 진행하기 전에 \`console_todo\` 로 이 할 일을 다시 읽으세요.`
    : `${word}\n\nThe person changed this item since you last read it (${what}). Read it again with \`console_todo\` before you proceed.`;
}
