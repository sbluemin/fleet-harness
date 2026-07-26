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

export interface LedgerSummaryDto {
  readonly schemaVersion: 1;
  readonly scope: { readonly theaterId: string | null; readonly window: LedgerWindow };
  readonly generatedAtMs: number;
  readonly totals: LedgerUsage & { readonly costUsd: number; readonly messages: number };
  readonly operations: LedgerOperationDto[];
  /** Theater와 Operation 귀속 여부에 무관한 이 기기 전체의 CLI별 사용량이다. */
  readonly clients: LedgerClientDto[];
  /** 사용량 수집에 쓰는 외부 도구는 구현 세부이므로 브라우저 payload에 이름·버전을 싣지 않는다. */
  readonly source: {
    readonly status: LedgerSourceStatus;
    readonly skippedSessions: number;
  };
}
