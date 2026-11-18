/**
 * Anthropic Claude 5.5 단가표와 지출 계산. 이 파일이 플릿이 아는 Anthropic 단가의 원본이다.
 *
 * 출처: https://platform.claude.com/docs/en/about-claude/pricing — **2026-11-18 확인**(USD / MTok).
 * API가 단가를 주지 않으므로 플릿이 직접 싣는다. 단위는 Gemini 단가표와 같다: **토큰당 pico-USD** 정수
 * (= USD/MTok × 1e6). 예: $4 / MTok → 4_000_000 pico-USD/token. 지출은 이 정수로만 누적한다.
 *
 * | 모델 | 입력 | 5분 캐시 쓰기 | 1시간 캐시 쓰기 | 캐시 읽기 | 출력 |
 * |---|---|---|---|---|---|
 * | Opus 5.5 | 4 | 5 | 8 | 0.20 | 20 |
 * | Sonnet 5.5 | 2 | 2.50 | 4 | 0.10 | 10 |
 * | Haiku 5.5 (프롬프트 ≤100,000토큰) | 0.10 | 0.125 | 0.20 | 0.01 | 0.50 |
 * | Haiku 5.5 (프롬프트 >100,000토큰) | 0.50 | 0.625 | 1 | 0.05 | 2.50 |
 *
 * - **Haiku 5.5 구간**: 프롬프트 길이 = 캐시 읽기·쓰기를 포함한 **모든 입력 토큰**이고, 요청마다 따로
 *   판정한다(임계를 넘긴 요청은 일부가 캐시 적중이어도 높은 단가). Opus·Sonnet 5.5는 1M 전 구간 단일 단가다.
 * - 캐시 읽기는 Opus·Sonnet 5.5가 입력의 0.05배, Haiku 5.5가 0.1배다.
 * - 웹 검색은 검색 1회당 $0.01($10 / 1,000회)이 토큰 비용에 더해진다. 웹 가져오기는 추가 비용이 없다.
 * - `inference_geo: "us"`(미국 한정 추론)는 4.6 이후 모델에서 모든 토큰 단가의 ×1.1이다. 기본(global)은 표준.
 * - **Fast는 지원하지 않는다**(사람 결정 8bc0021d). 게이트웨이가 `speed`를 지우므로 표에 Fast 단가가 없다.
 */

import type { AnthropicModelId } from "../upstream/anthropic/coordinates.js";
import type { AnthropicUsageObservation } from "./anthropic-usage.js";

export const ANTHROPIC_PRICING_SOURCE = {
  url: "https://platform.claude.com/docs/en/about-claude/pricing",
  checkedAt: "2026-11-18",
} as const;

/** 한 토큰의 단가(pico-USD). */
export interface AnthropicTokenPrice {
  readonly input: bigint;
  readonly cacheWrite5m: bigint;
  readonly cacheWrite1h: bigint;
  readonly cacheRead: bigint;
  readonly output: bigint;
}

/** 웹 검색 1회 = $0.01 = 1e10 pico-USD. */
const WEB_SEARCH_PICO_USD = 10_000_000_000n;
/** Haiku 5.5의 높은 단가가 걸리는 프롬프트 길이 임계. 이 값을 **넘어야** 높은 단가다. */
const HAIKU_LONG_PROMPT_TOKENS = 100_000;

const OPUS_5_5: AnthropicTokenPrice = { input: 4_000_000n, cacheWrite5m: 5_000_000n, cacheWrite1h: 8_000_000n, cacheRead: 200_000n, output: 20_000_000n };
const SONNET_5_5: AnthropicTokenPrice = { input: 2_000_000n, cacheWrite5m: 2_500_000n, cacheWrite1h: 4_000_000n, cacheRead: 100_000n, output: 10_000_000n };
const HAIKU_5_5_SHORT: AnthropicTokenPrice = { input: 100_000n, cacheWrite5m: 125_000n, cacheWrite1h: 200_000n, cacheRead: 10_000n, output: 500_000n };
const HAIKU_5_5_LONG: AnthropicTokenPrice = { input: 500_000n, cacheWrite5m: 625_000n, cacheWrite1h: 1_000_000n, cacheRead: 50_000n, output: 2_500_000n };

/** 요청의 프롬프트 길이(입력 + 캐시 쓰기 + 캐시 읽기)로 고른 단가. */
export function anthropicTokenPrice(model: AnthropicModelId, promptTokens: number): AnthropicTokenPrice {
  switch (model) {
    case "claude-opus-5-5": return OPUS_5_5;
    case "claude-sonnet-5-5": return SONNET_5_5;
    case "claude-haiku-5-5": return promptTokens > HAIKU_LONG_PROMPT_TOKENS ? HAIKU_5_5_LONG : HAIKU_5_5_SHORT;
  }
}

/** 음수·NaN·소수는 0으로 접는다. 게이트웨이가 이상한 수를 실어도 원장이 음수 지출을 만들지 않게. */
function tokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * 한 턴의 지출(pico-USD).
 *
 * 출력은 `output_tokens` 하나다 — thinking은 거기에 이미 포함돼 있다(`output_tokens_details.thinking_tokens`는
 * 그 부분집합). 입력은 네 갈래를 각자의 단가로 센다.
 */
export function anthropicTurnCostPicoUsd(observation: AnthropicUsageObservation): bigint {
  const input = tokenCount(observation.inputTokens);
  const read = tokenCount(observation.cacheReadTokens);
  const write5m = tokenCount(observation.cacheWrite5mTokens);
  const write1h = tokenCount(observation.cacheWrite1hTokens);
  const price = anthropicTokenPrice(observation.model, input + read + write5m + write1h);
  const tokens = BigInt(input) * price.input
    + BigInt(read) * price.cacheRead
    + BigInt(write5m) * price.cacheWrite5m
    + BigInt(write1h) * price.cacheWrite1h
    + BigInt(tokenCount(observation.outputTokens)) * price.output;
  // 미국 한정 추론은 토큰 단가만 1.1배다. 검색 요금은 요청당 요금이라 곱하지 않는다(Agent SDK 비용 문서도 같게 센다).
  const scaled = observation.inferenceGeo === "us" ? (tokens * 11n + 5n) / 10n : tokens;
  return scaled + BigInt(tokenCount(observation.webSearchRequests)) * WEB_SEARCH_PICO_USD;
}
