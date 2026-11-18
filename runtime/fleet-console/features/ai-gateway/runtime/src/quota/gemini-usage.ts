import type { GeminiModelId } from "../upstream/gemini/coordinates.js";

/**
 * Gemini 업스트림 → 지출 원장 포트.
 *
 * Gemini API는 잔액·지출·한도를 API로 주지 않는다. 그래서 게이트웨이가 응답마다 본 사실을
 * 이 포트로 넘기고, 원장(호스트가 주입)이 토큰 × 단가로 이번 달 지출을 센다. 게이트웨이는 단가·
 * 월 경계·예산을 모르고, 원장은 wire 형식을 모른다.
 *
 * 호출 규칙:
 * - `observeUsage`는 한 턴이 정상 종료(스트림 완결)했을 때 한 번만 부른다. 스트리밍 응답의
 *   usageMetadata는 매 청크에 누적값으로 오므로(2026-11-18 실측) 합산하지 말고 마지막 값을 싣는다.
 *   usageMetadata가 끝내 없으면 부르지 않는다(0으로 지어내지 않는다).
 * - `observeBlock`은 업스트림이 HTTP 402 또는 429로 거절했을 때(스트림 중 오류 이벤트 포함) 부른다.
 *   다른 상태 코드는 부르지 않는다.
 * - 원장은 같은 공급자의 `observeUsage`가 다시 오면 이전 차단 표시를 걷는다.
 * - 두 함수 모두 동기·무예외여야 한다. 저장이 비동기라도 원장이 안에서 삼키고, 추론 경로를 막지 않는다.
 */
export interface GeminiUsagePort {
  readonly observeUsage: (observation: GeminiUsageObservation) => void;
  readonly observeBlock: (observation: GeminiBlockObservation) => void;
}

export interface GeminiUsageObservation {
  readonly model: GeminiModelId;
  /** 턴이 끝난 시각(epoch ms). 원장이 월 경계와 단가 전환일을 이 값으로 고른다. */
  readonly at: number;
  /** `usageMetadata.serviceTier` 원문(예: "standard"). 없으면 생략한다. 단가 tier 선택에 쓴다. */
  readonly serviceTier?: string;
  /** `usageMetadata.promptTokenCount`. 캐시 적중분을 포함한 전체 입력. */
  readonly promptTokens: number;
  /** `usageMetadata.cachedContentTokenCount`, 없으면 0. promptTokens의 부분집합이다. */
  readonly cachedTokens: number;
  /** `usageMetadata.candidatesTokenCount`, 없으면 0. */
  readonly candidatesTokens: number;
  /** `usageMetadata.thoughtsTokenCount`, 없으면 0. 출력 단가로 과금된다. */
  readonly thoughtsTokens: number;
}

/** 402 = Prepay 잔액 소진, 429 = 한도 초과(분당·일일·지출 속도 한도). */
export type GeminiBlockReason = "balance_depleted" | "rate_limited";

export interface GeminiBlockObservation {
  readonly model: GeminiModelId;
  readonly at: number;
  readonly httpStatus: 402 | 429;
  readonly reason: GeminiBlockReason;
  /** 오류 본문의 기계 코드(`error.status` 또는 `error.code` 문자열, 예: "RESOURCE_EXHAUSTED"). */
  readonly code?: string;
  /** 오류 본문 `error.message` 원문. 키·요청 본문을 담지 않는다. */
  readonly message?: string;
}
