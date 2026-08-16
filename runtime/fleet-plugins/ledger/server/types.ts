export type LedgerWindow = "today" | "week" | "month";
export type LedgerSourceStatus = "ok" | "degraded" | "bootstrapping" | "unavailable" | "unreadable";

/** Claude Code report metadata used only to assign model-ledger rows to a local day. */
export interface TokscaleSession {
  readonly sessionId: string;
  readonly lastActive: number;
}

/** One Claude Code session + model row from tokscale's models ledger. */
export interface TokscaleModelEntry {
  readonly sessionId: string;
  readonly modelId: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
  readonly messages: number;
}

export interface LedgerUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

export interface LedgerModelRowDto {
  readonly modelId: string;
  /** Anthropic for native Claude ids; otherwise the provider encoded by claude-gateway--<provider>--. */
  readonly provider: string;
  readonly label: string;
  readonly usage: LedgerUsage;
  readonly costUsd: number;
  readonly messages: number;
}

export interface LedgerDailyPoint {
  readonly day: string;
  readonly costUsd: number;
}

export interface LedgerDailyDetailDto {
  readonly day: string;
  readonly costUsd: number;
  readonly usage: LedgerUsage;
  readonly messages: number;
  readonly models: readonly LedgerModelRowDto[];
  readonly modelCount: number;
}

export interface LedgerSummaryDto {
  readonly schemaVersion: 2;
  readonly scope: { readonly window: LedgerWindow };
  readonly generatedAtMs: number;
  /** Claude Code model-ledger rows are the single source of every total. */
  readonly totals: LedgerUsage & { readonly costUsd: number; readonly messages: number };
  /** Window-wide native Anthropic and Gateway-provider model rows. Maximum 80 rows; modelCount is uncapped. */
  readonly modelRows: readonly LedgerModelRowDto[];
  readonly modelCount: number;
  /** Local-day cost axis. Report metadata supplies dates, never cost. */
  readonly daily: readonly LedgerDailyPoint[];
  readonly dailyDetails: readonly LedgerDailyDetailDto[];
  readonly dailySource: {
    /** Valid Claude Code model rows whose session date could not be found in report metadata. */
    readonly unmatchedEntries: number;
  };
  /** External tool identity and raw errors remain server-private. */
  readonly source: {
    readonly status: LedgerSourceStatus;
    readonly models: LedgerSourceStatus;
    readonly report: LedgerSourceStatus;
    readonly skippedEntries: number;
    readonly skippedSessions: number;
  };
}
