import type { SystemOneClient } from "./client.js";
import type {
  AnswersFor,
  ChoiceQuestion,
  ConfidenceKeys,
  NoulQuestion,
  ScoreQuestion,
  SystemOneInstructions,
  SystemOneQuestions,
  SystemOneState,
  SystemOneUsage,
} from "./protocol.js";

/**
 * 재사용 단위. 질문 묶음과 그 판단을 믿어도 되는 지점(임계값)을 한 자리에 선언해 두면,
 * 호출부는 한 줄이 되고 임계값 조정이 호출부 수정이 아니라 선언 한 줄 변경이 된다.
 */
export interface SystemOneDecision<Q extends SystemOneQuestions> {
  readonly id: string;
  readonly questions: Q;
  readonly model?: string;
  /** confidence를 싣는 질문에만 걸 수 있다 — Noul은 값 자체가 확률이라 대상이 아니다. */
  readonly thresholds?: Partial<Readonly<Record<ConfidenceKeys<Q>, number>>>;
}

export interface SystemOneDecisionOutcome<Q extends SystemOneQuestions> {
  readonly model: string;
  readonly answers: AnswersFor<Q>;
  readonly usage: SystemOneUsage;
  /**
   * 질문별로 선언한 임계값을 넘겼는지. 임계값을 선언하지 않은 질문은 `true`다 —
   * 게이트를 걸지 않겠다는 선언이지, 판단이 확실하다는 뜻이 아니다.
   */
  readonly confident: Readonly<Record<ConfidenceKeys<Q>, boolean>>;
}

export function defineDecision<const Q extends SystemOneQuestions>(
  decision: SystemOneDecision<Q>,
): SystemOneDecision<Q> {
  return decision;
}

export async function runDecision<Q extends SystemOneQuestions>(
  client: SystemOneClient,
  decision: SystemOneDecision<Q>,
  state: SystemOneState,
  options?: { readonly signal?: AbortSignal },
): Promise<SystemOneDecisionOutcome<Q>> {
  const result = await client.ask({
    state,
    questions: decision.questions,
    model: decision.model,
    signal: options?.signal,
  });
  const confident: Record<string, boolean> = {};
  for (const [name, answer] of Object.entries(result.answers as Record<string, unknown>)) {
    const carried = (answer as { confidence?: unknown }).confidence;
    if (typeof carried !== "number") continue;
    const threshold = (decision.thresholds as Record<string, number> | undefined)?.[name];
    confident[name] = threshold === undefined ? true : carried >= threshold;
  }
  return {
    model: result.model,
    answers: result.answers,
    usage: result.usage,
    confident: confident as Readonly<Record<ConfidenceKeys<Q>, boolean>>,
  };
}

/** 선택지 리터럴이 답 타입까지 전달되도록 `criteria` 키를 그대로 좁혀 잡는다. */
export function choice<const Option extends string>(input: {
  readonly instructions: SystemOneInstructions;
  readonly criteria: Readonly<Record<Option, SystemOneInstructions | null>>;
}): ChoiceQuestion<Option> {
  return { type: "choice", instructions: input.instructions, criteria: input.criteria };
}

export function score<const Levels extends readonly string[]>(input: {
  readonly instructions: SystemOneInstructions;
  readonly criteria: Levels;
}): ScoreQuestion<Levels> {
  return { type: "score", instructions: input.instructions, criteria: input.criteria };
}

export function noul(input: {
  readonly instructions: SystemOneInstructions;
  readonly criteria?: NoulQuestion["criteria"];
}): NoulQuestion {
  return { type: "noul", instructions: input.instructions, criteria: input.criteria };
}
