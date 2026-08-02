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

export interface QuotaWindow {
  readonly id: WindowId;
  /** Absent when the window covers the provider's whole allowance. */
  readonly scope?: QuotaScope;
  readonly label?: string;
  readonly usedPercent: number;
  readonly resetsAt?: number;
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
