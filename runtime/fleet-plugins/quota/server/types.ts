export type ProviderStatus = "ok" | "not_connected" | "signed_out" | "expired" | "stale" | "error";
export type CredentialMethod = "keychain" | "file";
export type WindowId = "session" | "weekly" | "model";

export interface QuotaWindow {
  readonly id: WindowId;
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
  readonly windows?: readonly QuotaWindow[];
  readonly credits?: ResetCredits;
  readonly fetchedAt?: number;
  readonly message?: string;
}

export interface QuotaSummaryDto {
  readonly providers: {
    readonly claude: ProviderDto;
    readonly codex: ProviderDto;
  };
}

export interface ProviderSuccess {
  readonly status: "ok";
  readonly method?: CredentialMethod;
  readonly plan?: string;
  readonly windows: readonly QuotaWindow[];
  readonly credits?: ResetCredits;
  readonly fetchedAt: number;
}

export type ProviderResult = ProviderSuccess | ProviderDto;
