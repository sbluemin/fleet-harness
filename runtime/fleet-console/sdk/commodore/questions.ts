import { z } from "zod";

export const MAX_DECISION_QUESTIONS = 4;
export const MAX_DECISION_OPTIONS = 4;
export const MAX_DECISION_QUESTION = 1000;
export const MAX_DECISION_LABEL = 120;
export const MAX_DECISION_DESCRIPTION = 300;
export const MAX_DECISION_ANSWER = 2000;

const ids = z.string().min(1).max(128);
/** 새 입력에만 쓰는 상한 — 저장된 기록의 이전 상한은 유지한다. */
export const MAX_SHORT_INPUT = 50;
export const MAX_DECISION_QUESTION_INPUT = 100;
/** 질문 머리말 — 칩으로 서는 아주 짧은 이름(예: 「배포 범위」). */
export const MAX_DECISION_HEADER_INPUT = 12;
/** 사람이 직접 쓰는 답 — 결정 요청·사령관의 질문에 쓰는 모든 답 입력의 상한. */
export const MAX_DECISION_ANSWER_INPUT = 150;

/**
 * 지휘관이 올리는 질문 — 머리말 칩, 질문 문장, 선택지는 0개(직접 쓰기만) 또는 2개 이상. 선택지가 있어도 사람은 늘 직접 쓴 답을
 * 함께 보낼 수 있다. 임무·구성원은 같은 목표의 id 다.
 */
export const decisionQuestionSchema = z.object({
  header: z.string().trim().min(1).max(MAX_DECISION_HEADER_INPUT).describe(`Very short label shown as a chip above the question (max ${MAX_DECISION_HEADER_INPUT} chars), e.g. "Scope" or "Release".`),
  text: z.string().trim().min(1).max(MAX_DECISION_QUESTION_INPUT).describe("The complete question, clear and specific."),
  options: z.array(z.object({ label: z.string().trim().min(1).max(MAX_SHORT_INPUT), description: z.string().trim().max(MAX_SHORT_INPUT).optional() }).strict()).max(MAX_DECISION_OPTIONS).refine((options) => options.length !== 1, { message: "one_option" }),
  multiSelect: z.boolean().optional(),
  missionId: ids.optional(),
  memberId: ids.optional(),
}).strict();
export type DecisionQuestionInput = z.output<typeof decisionQuestionSchema>;
/** 사람이 보드에서 보내는 답 — 요청의 모든 질문에 한 번에. 직접 쓴 말은 다듬지 않고 그대로 싣는다. */
export const decisionAnswersSchema = z.object({
  requestId: ids,
  answers: z.array(z.object({ questionId: ids, selectedOptionIds: z.array(ids).max(MAX_DECISION_OPTIONS), text: z.string().max(MAX_DECISION_ANSWER_INPUT) }).strict()).min(1).max(MAX_DECISION_QUESTIONS),
}).strict();
export type DecisionAnswersInput = z.output<typeof decisionAnswersSchema>;
/** 저장된 머리말 — 머리말이 없던 때의 요청·기록은 그대로 읽는다. */
export const storedDecisionHeader = z.string().min(1).max(MAX_DECISION_LABEL);

/**
 * 내 의견 — 선택지가 있는 질문에 아무것도 고르지 않고 글만 보낸 답. 사람이 지휘관의 선택지를 모두 버리고 자기 답을 냈다는
 * 뜻이다. 보드의 「내 의견으로 답하기」 줄은 저장된 선택지가 아니어서 따로 남기지 않고 이 모양으로 판정한다(옛 기록도 같다).
 */
export const ownAnswer = (question: { readonly options: readonly unknown[] }, answer: { readonly selectedOptionIds: readonly string[]; readonly text: string }): boolean =>
  question.options.length > 0 && answer.selectedOptionIds.length === 0 && answer.text.trim().length > 0;
