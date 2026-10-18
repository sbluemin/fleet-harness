import type { QuotaWindowRisk } from "./pressure.js";

export type ProviderStatus = "ok" | "not_connected" | "signed_out" | "expired" | "no_subscription" | "stale" | "error";
export type CredentialMethod = "keychain" | "file";
export type WindowId = "session" | "weekly" | "model" | "cycle";

/**
 * Sub-budget a window measures, when a provider bills one subscription through
 * more than one pool. Cursor's exposed models draw from the Auto allowance, so
 * a caller choosing a model must read its scoped window — the pool-less window
 * is the provider's combined usage and can read as healthy while Auto is
 * exhausted.
 */
export type QuotaScope = "auto";

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
 * Emitted only where the upstream unit is a plain count (never money); Cursor's
 * spend figures stay excluded because they track billing amounts.
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

export interface ProviderDto {
  readonly status: ProviderStatus;
  readonly method?: CredentialMethod;
  readonly plan?: string;
  readonly cycleDays?: number;
  readonly windows?: readonly QuotaWindow[];
  readonly credits?: ResetCredits;
  readonly fetchedAt?: number;
  readonly message?: string;
  /**
   * 왜 stale인가. 없으면 마지막 조회가 실패한 것이다. `no_window`는 공급자가 정상으로
   * 답했지만 진행 중인 사용 창이 없어, 리셋 전의 마지막 창을 보여주는 경우다.
   */
  readonly staleReason?: "no_window";
}

export interface QuotaSummaryDto {
  readonly providers: {
    readonly antigravity: ProviderDto;
    readonly claude: ProviderDto;
    readonly codex: ProviderDto;
    readonly cursor: ProviderDto;
    readonly "muse-code": ProviderDto;
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
