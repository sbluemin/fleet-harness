import type { LedgerLaunchProvider } from "./identity.js";

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

export interface TokscaleModelEntry {
  readonly modelId: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly costUsd: number;
  readonly messages: number;
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
  readonly launchProvider: LedgerLaunchProvider | null;
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

export interface LedgerSupplierDto {
  readonly supplier: string;
  readonly models: number;
  readonly usage: LedgerUsage;
  readonly costUsd: number;
  readonly messages: number;
}

export interface LedgerModelRowDto {
  readonly modelId: string;
  readonly label: string;
  readonly supplier: string;
  readonly usage: LedgerUsage;
  readonly costUsd: number;
  readonly messages: number;
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
  readonly launchProvider: LedgerLaunchProvider | null;
  /** 사용량 활동이 없으므로 Operation의 최종 갱신 시각(ts.updatedAt)을 싣는다. */
  readonly lastActivityAtMs: number;
}

export interface LedgerSummaryDto {
  readonly schemaVersion: 1;
  readonly scope: { readonly theaterId: string | null; readonly window: LedgerWindow };
  readonly generatedAtMs: number;
  readonly totals: LedgerUsage & { readonly costUsd: number; readonly messages: number };
  readonly operations: LedgerOperationDto[];
  /** 저장 세션은 있으나 이 window에서 매칭된 사용량이 없는 Operation이다(스코프 필터 적용). 최대 50건으로 자르고 전체 수는 unmatchedTotal이 든다. */
  readonly unmatched: readonly LedgerUnmatchedOperationDto[];
  /** 스코프 안 미매칭 Operation 전체 수다. unmatched가 잘렸을 때도 커버리지 라인이 정확하도록 분리한다. */
  readonly unmatchedTotal: number;
  /** 스코프가 특정 Theater일 때, 다른 Theater의 Console Operation에 귀속된 사용량이다. all-theaters 스코프에서는 항상 0이다. */
  readonly otherTheaterTotals: LedgerUsage & { readonly costUsd: number; readonly messages: number };
  /** 스코프와 무관한 이 기기 전체 합계다. totals(귀속분)와의 관계를 화면에 드러내는 근거다. */
  readonly deviceTotals: LedgerUsage & { readonly costUsd: number; readonly messages: number; readonly sessions: number };
  /**
   * Theater와 Operation 귀속 여부에 무관한 이 기기 전체의 CLI별 사용량이다.
   * 패널은 이 축을 더 이상 그리지 않는다 — 공급자/모델 분해는 suppliers·modelRows다.
   */
  readonly clients: LedgerClientDto[];
  /** tokscale `models` 명령의 기기 전체 공급자 합이다. deviceTotals와 더하지 않는다. */
  readonly suppliers: readonly LedgerSupplierDto[];
  /** tokscale `models` 명령의 기기 전체 모델 행이다. 세션 비용을 모델로 나눈 값이 아니다. */
  readonly modelRows: readonly LedgerModelRowDto[];
  /** suppliers·modelRows와 같은 출처의 합이다. 히어로(totals)와 다른 숫자일 수 있다. */
  readonly modelTotals: LedgerUsage & { readonly costUsd: number; readonly messages: number; readonly models: number };
  readonly modelSource: {
    readonly status: LedgerSourceStatus;
    readonly skippedEntries: number;
  };
  /** Theater와 Operation 귀속 여부에 무관한 이 기기 전체의 일별 비용이다. */
  readonly daily: readonly LedgerDailyPoint[];
  /** daily와 같은 날짜 축에서, 스코프 안 Console Operation에 귀속된 일별 비용이다(차트의 귀속 레이어). */
  readonly dailyAttributed: readonly LedgerDailyPoint[];
  /** 사용량 수집에 쓰는 외부 도구는 구현 세부이므로 브라우저 payload에 이름·버전을 싣지 않는다. */
  readonly source: {
    readonly status: LedgerSourceStatus;
    readonly skippedSessions: number;
  };
}
