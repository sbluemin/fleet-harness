import type { QuotaWindowRisk } from "./pressure.js";

export type ProviderStatus = "ok" | "not_connected" | "signed_out" | "expired" | "no_subscription" | "stale" | "error";
export type CredentialMethod = "keychain" | "file";
export type WindowId = "session" | "weekly" | "model" | "cycle";

/**
 * Sub-budget a window measures, when a provider bills one subscription through
 * more than one pool. A scoped window must not be confused with the provider's
 * combined usage, which can be healthy while one pool is exhausted.
 *
 * - `"pool:<slug>"` — a model family that shares one allowance (e.g. Antigravity's
 *   `"pool:gemini"` and `"pool:claude-gpt"`). Every model of the family binds to it.
 * - `"model:<slug>"` — a single model's own limit inside its pool (e.g.
 *   `"model:fable"`, `"model:gemini-4-argon"`).
 * - `"auto"` — a legacy named sub-pool.
 */
export type QuotaScope = "auto" | `pool:${string}` | `model:${string}`;

/**
 * Where a window's time boundary came from. `upstream` is a value the provider
 * stated; `catalog` is Fleet's knowledge of the product (e.g. Claude's 5-hour
 * session), which can go stale silently if the product changes; `derived` is
 * arithmetic over the other two (e.g. start = reset − duration), which assumes
 * a contiguous fixed window. Consumers may weight trust by this tag.
 */
export type WindowDurationBasis = "upstream" | "catalog";
export type WindowStartBasis = "upstream" | "derived";

export interface QuotaWindowPeriod {
  readonly durationMs: number;
  readonly durationBasis: WindowDurationBasis;
  readonly startsAt?: number;
  readonly startsAtBasis?: WindowStartBasis;
}

/**
 * Absolute usage as decimal strings, exactly as the provider quantifies them.
 * Emitted only where the upstream unit is a plain count (never money).
 */
export interface QuotaWindowAmounts {
  readonly used: string;
  readonly limit: string;
}

export interface QuotaWindow {
  readonly id: WindowId;
  /** Absent when the window covers the provider's whole allowance. */
  readonly scope?: QuotaScope;
  readonly label?: string;
  readonly usedPercent: number;
  readonly resetsAt?: number;
  /**
   * The window's time boundary. Without it, `usedPercent` values from windows
   * that reset on different clocks (5h vs weekly vs monthly) are incomparable.
   */
  readonly period?: QuotaWindowPeriod;
  /**
   * Marks a window whose figure is the sum of sibling scoped windows rather
   * than a pool of its own; headroom math must not count it twice.
   */
  readonly isAggregate?: true;
  readonly amounts?: QuotaWindowAmounts;
  /**
   * Judgements derived from the fields above, attached by the summary service.
   * Provider probes never set it — keeping it in its own object is what stops a
   * reader from mistaking a verdict for something the provider stated.
   */
  readonly risk?: QuotaWindowRisk;
}

export interface ResetCredits {
  readonly available: number;
  readonly nextExpiresAt?: number;
}

/**
 * Money a provider is billed in, as far as Fleet can measure it.
 *
 * 금액은 부동소수 누적을 하지 않는다 — 원장이 정수(pico-USD)로 세고, 경계를 넘을 때만
 * 십진 문자열로 바꾼다. 이 DTO는 그 문자열을 그대로 나른다. `budget`이 없으면 금액만
 * 보이고, 있으면 이번 달 사용률 막대를 세운다. 이 값은 `QuotaWindow`가 아니다: routing은
 * `windows`로 압박도를 계산하므로, 지출을 창으로 만들면 사람이 요청한 적 없는 라우팅 제외가 생긴다.
 */
export interface ProviderSpend {
  readonly currency: "USD";
  /** 이번 달 누적 지출. USD 십진 문자열(최대 12자리 소수). */
  readonly spent: string;
  /** 사람이 정한 월 예산. 모든 달에 적용된다. 없으면 금액만 보인다. */
  readonly budget?: string;
  /** `spent / budget` 백분율(소수 한 자리). 예산을 넘으면 100을 넘는다. */
  readonly usedPercent?: number;
  /** 이번 달 시작 — America/Los_Angeles 자정(epoch ms). */
  readonly periodStart: number;
  /** 다음 달 시작 = 이번 달 리셋 시각(epoch ms). */
  readonly resetsAt: number;
  /**
   * 값의 출처. Gemini API는 잔액·지출을 주지 않으므로 플릿이 응답 usageMetadata의 토큰에
   * 단가를 곱해 센 추정치다(Paid 티어 단가, 플릿은 프로젝트 티어를 모른다).
   */
  readonly basis: "fleet_measured";
}

/**
 * 업스트림이 거절한 마지막 사실. 다음 성공 사용량이 오면 원장이 걷는다.
 *
 * Gemini는 402·429만 쓴다. Anthropic은 잔액 소진이 HTTP 400 `invalid_request_error`로도 오므로
 * 400이 더해졌고, 그래서 **상태 코드만으로 사유를 정하지 않는다** — 모델 제약 400과 섞인다.
 * 사유는 `error.type`·`error.message`로 가린 값이다.
 */
export interface ProviderBlock {
  readonly httpStatus: 400 | 402 | 429;
  /**
   * - `balance_depleted`: 크레딧·선불 잔액 소진.
   * - `rate_limited`: 속도 한도.
   * - `spend_limit`: 사람이 정했거나 티어가 정한 월 지출 한도(Anthropic).
   */
  readonly reason: "balance_depleted" | "rate_limited" | "spend_limit";
  readonly at: number;
  readonly model?: string;
  /** 오류 본문의 기계 코드(예: "RESOURCE_EXHAUSTED", "payment_required"). */
  readonly code?: string;
  /** 오류 본문 `error.message` 원문. 키·요청 본문은 담지 않는다. */
  readonly message?: string;
}

/** `anthropic-ratelimit-*` 헤더 한 묶음(limit·remaining·reset). */
export interface ProviderRateLimitWindow {
  readonly limit: number;
  readonly remaining: number;
  /** epoch ms */
  readonly resetsAt: number;
}

/**
 * 마지막 상류 응답의 `anthropic-ratelimit-*` 헤더. 창(`QuotaWindow`)이 아니다 — 라우팅에 쓰지 않는다.
 * 크레딧 잔액이 아니라 API 키의 분당 한도 정보다.
 */
export interface ProviderRateLimit {
  /** epoch ms, 헤더를 본 시각 */
  readonly observedAt: number;
  readonly requests?: ProviderRateLimitWindow;
  readonly inputTokens?: ProviderRateLimitWindow;
  readonly outputTokens?: ProviderRateLimitWindow;
}

export interface ProviderDto {
  readonly status: ProviderStatus;
  readonly method?: CredentialMethod;
  readonly plan?: string;
  readonly cycleDays?: number;
  readonly windows?: readonly QuotaWindow[];
  readonly credits?: ResetCredits;
  /** 지출을 금액으로만 아는 공급자(Gemini)의 이번 달 누적. 창이 아니다. */
  readonly spend?: ProviderSpend;
  /** 마지막 거절(402·429, Anthropic은 400 포함). 성공 사용량이 오면 사라진다. */
  readonly block?: ProviderBlock;
  /** API 키 공급자(Anthropic)가 마지막 응답 헤더에서 읽은 분당 한도. `windows`가 아니다. */
  readonly rateLimit?: ProviderRateLimit;
  readonly fetchedAt?: number;
  readonly message?: string;
}

export interface QuotaSummaryDto {
  readonly providers: {
    /**
     * Anthropic API 키(크레딧) — 플릿이 응답 usage로 센 이번 달 지출과 마지막 한도 헤더를 싣는다.
     * 구독 `claude`와 별도 항목이다.
     */
    readonly anthropic: ProviderDto;
    readonly antigravity: ProviderDto;
    readonly claude: ProviderDto;
    readonly codex: ProviderDto;
    /**
     * Gemini Developer API 키 — 플릿이 응답 토큰으로 센 이번 달 지출을 싣는다.
     * Antigravity 경로의 같은 모델과 별도 항목이다.
     */
    readonly gemini: ProviderDto;
    readonly "muse-code": ProviderDto;
    readonly opencode: ProviderDto;
    readonly xai: ProviderDto;
  };
}

export interface ProviderSuccess {
  readonly status: "ok";
  readonly method?: CredentialMethod;
  readonly plan?: string;
  readonly cycleDays?: number;
  readonly windows: readonly QuotaWindow[];
  readonly credits?: ResetCredits;
  readonly fetchedAt: number;
}

export type ProviderResult = ProviderSuccess | ProviderDto;
