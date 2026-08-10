import type { QuotaWindowRisk } from "./pressure.js";

export type ProviderStatus = "ok" | "not_connected" | "signed_out" | "expired" | "no_subscription" | "stale" | "error";
export type CredentialMethod = "keychain" | "file";
export type WindowId = "session" | "weekly" | "model" | "cycle";

/**
 * Sub-budget a window measures, when a provider bills one subscription through
 * more than one pool. Cursor spends Auto-tier models and API-tier models from
 * separate allowances, so a caller choosing a model must read the window that
 * matches that model's pool — the pool-less window is their sum and can read as
 * healthy while the pool the model actually draws from is exhausted.
 */
export type QuotaScope = "auto" | "api";

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
}

export interface QuotaSummaryDto {
  readonly providers: {
    readonly claude: ProviderDto;
    readonly codex: ProviderDto;
    readonly cursor: ProviderDto;
    readonly kimi: ProviderDto;
    readonly opencode: ProviderDto;
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
