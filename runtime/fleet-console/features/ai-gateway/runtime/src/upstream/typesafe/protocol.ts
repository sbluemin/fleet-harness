/**
 * TypeSafe System One wire.
 *
 * 이 공급자는 게이트웨이의 나머지 upstream과 방향이 반대다. 다른 공급자는 Agent CLI가
 * 쓴 inbound wire를 중계받지만, System One을 말하는 클라이언트는 없다 — 호출의 출발점이
 * Fleet 자신이다. 그래서 이 wire는 `src/canonical/`(messages·tools·events)과 교집합이
 * 없고, 라우터를 거치지 않으며, 자기 어휘(state·questions·answers)를 스스로 소유한다.
 *
 * 텍스트를 생성하지 않는 대신 질문마다 타입이 정해진 값과 확률분포를 돌려준다. 아래
 * 제네릭이 존재하는 이유가 그것이다: 질문 맵에서 답 타입을 유도해, 선택지 오타가
 * 런타임이 아니라 컴파일에서 깨지게 한다.
 */

/** 모델에 건네는 서술. 문자열, 또는 보조 자료를 형제 필드로 묶은 구조. */
export type SystemOneInstructions = string | Record<string, unknown> | readonly unknown[];

/** 판단 대상. 평문이거나 대화 로그·레코드 같은 구조화 자료. */
export type SystemOneState = string | Record<string, unknown> | readonly unknown[];

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: SystemOneInstructions;
  readonly criteria?: {
    readonly true?: SystemOneInstructions;
    readonly false?: SystemOneInstructions;
  };
}

export interface ChoiceQuestion<Option extends string = string> {
  readonly type: "choice";
  readonly instructions: SystemOneInstructions;
  readonly criteria: Readonly<Record<Option, SystemOneInstructions | null>>;
}

export interface ScoreQuestion<Levels extends readonly string[] = readonly string[]> {
  readonly type: "score";
  readonly instructions: SystemOneInstructions;
  readonly criteria: Levels;
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion<string> | ScoreQuestion;
export type SystemOneQuestions = Readonly<Record<string, SystemOneQuestion>>;

export interface NoulAnswer {
  readonly type: "noul";
  /** 0(아니오)에서 1(예)까지. Noul은 confidence를 따로 싣지 않는다 — 값 자체가 확률이다. */
  readonly noul: number;
}

export interface ChoiceAnswer<Option extends string = string> {
  readonly type: "choice";
  readonly choice: Option;
  readonly probabilities: Readonly<Record<Option, number>>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type: "score";
  /** 단계 사이에 놓일 수 있는 확률 가중값. */
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export type SystemOneAnswer = NoulAnswer | ChoiceAnswer<string> | ScoreAnswer;

/** 질문 하나에서 그 답 타입을 유도한다. Choice는 선택지 리터럴까지 좁혀진다. */
export type AnswerFor<Q> = Q extends ChoiceQuestion<infer Option>
  ? ChoiceAnswer<Option>
  : Q extends ScoreQuestion
    ? ScoreAnswer
    : Q extends NoulQuestion
      ? NoulAnswer
      : never;

export type AnswersFor<Q extends SystemOneQuestions> = { readonly [K in keyof Q]: AnswerFor<Q[K]> };

/** confidence를 싣는 답만 고른다 — 임계값 게이트를 걸 수 있는 질문들. */
export type ConfidenceKeys<Q extends SystemOneQuestions> = {
  [K in keyof Q]: AnswerFor<Q[K]> extends { confidence: number } ? K : never;
}[keyof Q];

export interface SystemOneUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface SystemOneResult<Q extends SystemOneQuestions> {
  readonly model: string;
  readonly answers: AnswersFor<Q>;
  readonly usage: SystemOneUsage;
}

export interface SystemOneModelCard {
  readonly name: string;
  readonly description: string;
  readonly releaseDate?: string;
}

/** 공급자가 선언한 한도. 요청을 보내기 전에 지역에서 걸러 400 왕복을 아낀다. */
export const SYSTEM_ONE_MAX_CHOICE_OPTIONS = 255;
export const SYSTEM_ONE_MIN_SCORE_LEVELS = 2;
export const SYSTEM_ONE_MAX_SCORE_LEVELS = 10;

export function encodeSystemOneRequest(input: {
  readonly state: SystemOneState;
  readonly model: string;
  readonly questions: SystemOneQuestions;
}): Record<string, unknown> {
  return { state: input.state, model: input.model, questions: input.questions };
}

/**
 * 응답 본문이 요청한 질문을 모두 답했는지 확인한다. 유도된 타입은 컴파일 시점 약속일
 * 뿐이므로, 그 약속이 실제 본문과 어긋나면 호출자가 `undefined`를 값으로 읽기 전에
 * 여기서 멈춘다.
 */
export function decodeSystemOneResult<Q extends SystemOneQuestions>(
  body: unknown,
  questions: Q,
): SystemOneResult<Q> {
  if (typeof body !== "object" || body === null) {
    throw new Error("System One response was not an object");
  }
  const payload = body as Record<string, unknown>;
  const answers = payload.answers;
  if (typeof answers !== "object" || answers === null) {
    throw new Error("System One response carried no answers");
  }
  const decoded = answers as Record<string, unknown>;
  for (const key of Object.keys(questions)) {
    if (!(key in decoded)) {
      throw new Error(`System One response is missing an answer for question '${key}'`);
    }
  }
  const usage = payload.usage as SystemOneUsage | undefined;
  return {
    model: typeof payload.model === "string" ? payload.model : "",
    answers: decoded as AnswersFor<Q>,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    },
  };
}
