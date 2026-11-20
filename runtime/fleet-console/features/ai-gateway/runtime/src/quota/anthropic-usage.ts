/**
 * Anthropic 상류 → 지출 원장 포트.
 *
 * 크레딧 잔액은 어떤 API로도 읽을 수 없다(2026-11-18 지휘관 실측: 워크스페이스 키 401, 조직 범위 키 403).
 * 그래서 게이트웨이가 응답마다 본 사실을 이 포트로 넘기고, 원장(호스트가 주입)이 토큰 × 단가로 지출을
 * 센다. 게이트웨이는 단가·월 경계·예산을 모르고, 원장은 와이어 형식을 모른다(Gemini 포트와 같은 분업).
 *
 * 호출 규칙:
 * - `observeUsage`는 한 턴이 **정상 종료**(스트림이 `message_stop`까지 완결)했고 최종 usage를 읽었을 때 한 번만
 *   부른다. 스트림이 끊겼거나 usage가 없으면 부르지 않는다 — 0으로 지어내지 않는다. 그래서 클라이언트가 턴
 *   도중 끊은 요청의 부분 청구는 세지 않는다(플릿 집계가 Console 잔액보다 작을 수 있는 이유 중 하나).
 * - `observeBlock`은 상류가 크레딧·지출 한도·속도 한도로 거절했을 때만 부른다(분류는 호출 쪽이 `error.type`·
 *   `message`로 한다). 다른 거절(모델 제약 400, 인증 401·403)은 차단이 아니다.
 * - 원장은 같은 공급자의 `observeUsage`가 다시 오면 이전 차단 표시를 걷는다.
 * - 두 함수 모두 동기·무예외여야 한다. 저장이 비동기라도 원장이 안에서 삼키고, 추론 경로를 막지 않는다.
 */
export interface AnthropicUsagePort {
  readonly observeUsage: (observation: AnthropicUsageObservation) => void;
  readonly observeBlock: (observation: AnthropicBlockObservation) => void;
}

export interface AnthropicUsageObservation {
  /** 상류 와이어 id(Claude Code 동기화가 알려 준 값, 예 `claude-opus-5-5`). 단가는 이 값으로 찾는다. */
  readonly model: string;
  /** 턴이 끝난 시각(epoch ms). 원장이 월 경계를 이 값으로 고른다. */
  readonly at: number;
  /** `usage.input_tokens` — 마지막 캐시 중단점 뒤의 캐시 밖 입력. */
  readonly inputTokens: number;
  /** `usage.output_tokens` — thinking을 포함한 청구 기준 총 출력. */
  readonly outputTokens: number;
  /** `usage.cache_read_input_tokens`. */
  readonly cacheReadTokens: number;
  /** 5분 TTL 캐시 쓰기 토큰. */
  readonly cacheWrite5mTokens: number;
  /** 1시간 TTL 캐시 쓰기 토큰. 단가가 5분의 1.6배다. */
  readonly cacheWrite1hTokens: number;
  /** `usage.server_tool_use.web_search_requests`. 검색 1회당 별도 요금이다. */
  readonly webSearchRequests: number;
  /** `usage.inference_geo` 원문(예: "global", "us"). 있으면 단가 배수 선택에 쓴다. */
  readonly inferenceGeo?: string;
}

/**
 * - `balance_depleted`: 크레딧·구매 잔액 소진, 또는 결제 문제(`billing_error`).
 * - `spend_limit`: 사람이 정했거나 티어가 정한 월 지출 한도.
 * - `rate_limited`: 분당 속도·램프 한도.
 */
export type AnthropicBlockReason = "balance_depleted" | "spend_limit" | "rate_limited";

export interface AnthropicBlockObservation {
  /** 상류 와이어 id(Claude Code 동기화가 알려 준 값, 예 `claude-opus-5-5`). 단가는 이 값으로 찾는다. */
  readonly model: string;
  readonly at: number;
  readonly httpStatus: 400 | 402 | 429;
  readonly reason: AnthropicBlockReason;
  /** 오류 본문의 기계 코드(`error.details.error_code`, 없으면 `error.type`). */
  readonly code?: string;
  /** 오류 본문 `error.message` 원문. 키·요청 본문을 담지 않는다. */
  readonly message?: string;
}
