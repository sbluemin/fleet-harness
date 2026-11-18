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
 *
 * **단가표에 없는 버전·가족** — 카탈로그의 상류 id는 Claude Code 동기화가 알려 주는 값이라 표보다 새 버전
 * (예: `claude-opus-5-6`)이 올 수 있다. 이 파일은 상류 id의 가족과 버전으로 단가를 찾는다:
 * 1. 표에 그 버전이 있으면 그 단가다(`estimated: false`).
 * 2. 가족은 있는데 버전이 없으면, 같은 가족에서 표에 있는 **가장 최근 버전**의 단가로 추정한다
 *    (`estimated: true`, `pricedAs`에 실제로 쓴 표의 id). 원장은 이를 `estimates`에 남긴다.
 * 3. 가족이 표에 없으면 단가가 없다(`undefined`). 비용을 지어내지 않고, 원장이 `unpriced`로만 센다.
 */

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

interface PricedVersion {
  /** 표의 상류 id(날짜 접미 없는 정식형). 원장이 "어느 단가로 셌는가"를 이 값으로 남긴다. */
  readonly id: string;
  readonly version: readonly number[];
  /** 요청의 프롬프트 길이(입력 + 캐시 쓰기 + 캐시 읽기)로 고른 단가. */
  readonly price: (promptTokens: number) => AnthropicTokenPrice;
}

/** 가족 별칭(카탈로그 `claudeAlias`와 같은 어휘) → 그 가족의 단가가 있는 버전들. */
const PRICE_TABLE: Readonly<Record<string, readonly PricedVersion[]>> = {
  opus: [{ id: "claude-opus-5-5", version: [5, 5], price: () => OPUS_5_5 }],
  sonnet: [{ id: "claude-sonnet-5-5", version: [5, 5], price: () => SONNET_5_5 }],
  haiku: [{
    id: "claude-haiku-5-5",
    version: [5, 5],
    price: (promptTokens) => (promptTokens > HAIKU_LONG_PROMPT_TOKENS ? HAIKU_5_5_LONG : HAIKU_5_5_SHORT),
  }],
};

/** `claude-opus-5-6` → { family: "opus", version: [5, 6] }. 날짜 접미(`-20251001`)·`[1m]` 표식은 버전이 아니다. */
function parseModelId(model: string): { readonly family: string; readonly version: readonly number[] } | undefined {
  const match = /^claude-([a-z]+)-((?:\d{1,3})(?:-\d{1,3})*)(?:-\d{8})?(?:\[1m\])?$/.exec(model);
  if (match === null) return undefined;
  return { family: match[1]!, version: match[2]!.split("-").map(Number) };
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export interface AnthropicModelPricing {
  readonly price: (promptTokens: number) => AnthropicTokenPrice;
  /** 단가를 실제로 가져온 표의 id. 정확히 맞으면 상류 id 자신이다. */
  readonly pricedAs: string;
  /** 같은 가족의 가장 최근 표 버전으로 추정했는가. */
  readonly estimated: boolean;
}

/** 상류 와이어 id의 단가. 가족이 표에 없으면 undefined(단가를 지어내지 않는다). */
export function resolveAnthropicPricing(model: string): AnthropicModelPricing | undefined {
  const parsed = parseModelId(model);
  if (parsed === undefined) return undefined;
  const versions = PRICE_TABLE[parsed.family];
  if (versions === undefined) return undefined;
  const exact = versions.find((entry) => compareVersions(entry.version, parsed.version) === 0);
  if (exact !== undefined) return { price: exact.price, pricedAs: exact.id, estimated: false };
  const latest = [...versions].sort((left, right) => compareVersions(right.version, left.version))[0]!;
  return { price: latest.price, pricedAs: latest.id, estimated: true };
}

/** 음수·NaN·소수는 0으로 접는다. 게이트웨이가 이상한 수를 실어도 원장이 음수 지출을 만들지 않게. */
function tokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export interface AnthropicTurnPricing {
  readonly costPicoUsd: bigint;
  readonly pricedAs: string;
  readonly estimated: boolean;
}

/**
 * 한 턴의 지출(pico-USD)과 그 근거. 단가가 없는 가족이면 undefined다.
 *
 * 출력은 `output_tokens` 하나다 — thinking은 거기에 이미 포함돼 있다(`output_tokens_details.thinking_tokens`는
 * 그 부분집합). 입력은 네 갈래를 각자의 단가로 센다.
 */
export function priceAnthropicTurn(observation: AnthropicUsageObservation): AnthropicTurnPricing | undefined {
  const pricing = resolveAnthropicPricing(observation.model);
  if (pricing === undefined) return undefined;
  const input = tokenCount(observation.inputTokens);
  const read = tokenCount(observation.cacheReadTokens);
  const write5m = tokenCount(observation.cacheWrite5mTokens);
  const write1h = tokenCount(observation.cacheWrite1hTokens);
  const price = pricing.price(input + read + write5m + write1h);
  const tokens = BigInt(input) * price.input
    + BigInt(read) * price.cacheRead
    + BigInt(write5m) * price.cacheWrite5m
    + BigInt(write1h) * price.cacheWrite1h
    + BigInt(tokenCount(observation.outputTokens)) * price.output;
  // 미국 한정 추론은 토큰 단가만 1.1배다. 검색 요금은 요청당 요금이라 곱하지 않는다(Agent SDK 비용 문서도 같게 센다).
  const scaled = observation.inferenceGeo === "us" ? (tokens * 11n + 5n) / 10n : tokens;
  return {
    costPicoUsd: scaled + BigInt(tokenCount(observation.webSearchRequests)) * WEB_SEARCH_PICO_USD,
    pricedAs: pricing.pricedAs,
    estimated: pricing.estimated,
  };
}
