export type LedgerWindow = "today" | "week" | "month";
export type LedgerSourceStatus = "ok" | "degraded" | "bootstrapping" | "unavailable" | "unreadable";

export interface TokscaleSession {
  readonly sessionId: string;
  readonly client: string;
  /** tokscale이 판정하지 못하면 null이다. Theater 스코프는 Operation.theaterId로 걸므로 쓰지 않는다. */
  readonly workspace: string | null;
  readonly workspaceLabel: string | null;
  readonly createdAt: number;
  readonly lastActive: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly costUsd: number;
  readonly models: readonly string[];
  readonly messages: number;
  readonly durationMinutes: number;
}

export interface LedgerUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

export interface LedgerOperationDto {
  readonly operationId: string;
  readonly title: string;
  readonly cliId: string;
  readonly cliLabel: string;
  readonly client: string;
  readonly messages: number;
  readonly usage: LedgerUsage;
  readonly costUsd: number;
  readonly models: string[];
  readonly lastActivityAtMs: number;
}

export interface LedgerClientDto {
  readonly client: string;
  readonly sessions: number;
  readonly usage: LedgerUsage;
  readonly costUsd: number;
}

export interface LedgerDailyPoint {
  readonly day: string;
  readonly costUsd: number;
}

/** 저장 세션은 있지만 이 window의 사용량 원본에서 매칭되지 않은 Operation이다. */
export interface LedgerUnmatchedOperationDto {
  readonly operationId: string;
  readonly title: string;
  readonly cliId: string;
  readonly cliLabel: string;
}

export interface LedgerSummaryDto {
  readonly schemaVersion: 1;
  readonly scope: { readonly theaterId: string | null; readonly window: LedgerWindow };
  readonly generatedAtMs: number;
  readonly totals: LedgerUsage & { readonly costUsd: number; readonly messages: number };
  readonly operations: LedgerOperationDto[];
  /** 저장 세션은 있으나 이 window에서 매칭된 사용량이 없는 Operation이다(스코프 필터 적용). */
  readonly unmatched: readonly LedgerUnmatchedOperationDto[];
  /** 스코프와 무관한 이 기기 전체 합계다. totals(귀속분)와의 관계를 화면에 드러내는 근거다. */
  readonly deviceTotals: LedgerUsage & { readonly costUsd: number; readonly messages: number; readonly sessions: number };
  /** Theater와 Operation 귀속 여부에 무관한 이 기기 전체의 CLI별 사용량이다. */
  readonly clients: LedgerClientDto[];
  /** Theater와 Operation 귀속 여부에 무관한 이 기기 전체의 일별 비용이다. */
  readonly daily: readonly LedgerDailyPoint[];
  /** 사용량 수집에 쓰는 외부 도구는 구현 세부이므로 브라우저 payload에 이름·버전을 싣지 않는다. */
  readonly source: {
    readonly status: LedgerSourceStatus;
    readonly skippedSessions: number;
  };
}
