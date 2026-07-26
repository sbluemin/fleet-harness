import os from "node:os";

import type { OperationNode } from "@fleet-console/sdk/operations";

import {
  type CliExecutor,
  ensureTokscaleBin,
  hasPinnedTokscale,
  TOKSCALE_TIMEOUT_MS,
} from "./cli.js";
import { parseTokscaleOutput } from "./parser.js";
import { buildSummary } from "./summary.js";
import type { LedgerSummaryDto, LedgerWindow } from "./types.js";

export interface SummaryRequest {
  readonly theaterId: string | null;
  readonly window: LedgerWindow;
  readonly refresh: boolean;
  readonly operations: readonly OperationNode[];
}

export interface LedgerService {
  getSummary(request: SummaryRequest): Promise<LedgerSummaryDto>;
}

interface LedgerServiceDeps {
  readonly cliHome: string;
  readonly executor: CliExecutor;
  readonly isInstalled?: (cliHome: string) => Promise<boolean>;
  readonly bootstrap?: (cliHome: string) => Promise<string>;
  readonly now?: () => number;
}

const CACHE_TTL_MS = 15_000;

export function createLedgerService(deps: LedgerServiceDeps): LedgerService {
  type ReportResult = {
    readonly sessions: ReturnType<typeof parseTokscaleOutput>["sessions"];
    readonly status: LedgerSummaryDto["source"]["status"];
    readonly skippedSessions: number;
    readonly generatedAtMs: number;
  };
  const cache = new Map<string, { readonly expiresAt: number; readonly report: ReportResult }>();
  const bootstrapPending = new Map<string, Promise<void>>();
  const reportInFlight = new Map<string, Promise<ReportResult>>();
  const isInstalled = deps.isInstalled ?? hasPinnedTokscale;
  const bootstrap = deps.bootstrap ?? ensureTokscaleBin;
  const now = deps.now ?? Date.now;

  function cacheKey(request: SummaryRequest): string {
    return request.window;
  }

  function summaryFromReport(request: SummaryRequest, report: ReportResult): LedgerSummaryDto {
    return buildSummary(report.sessions, request.operations, {
      theaterId: request.theaterId,
      window: request.window,
    }, report.status, report.generatedAtMs, report.skippedSessions);
  }

  function statusDto(request: SummaryRequest, status: "bootstrapping" | "unavailable"): LedgerSummaryDto {
    return summaryFromReport(request, { sessions: [], status, skippedSessions: 0, generatedAtMs: now() });
  }

  async function executeReport(window: LedgerWindow): Promise<ReportResult> {
    const args = ["report", "--json", "--no-summarize", `--${window}`];
    try {
      const result = await deps.executor(args, {
        cwd: os.homedir(),
        timeout: TOKSCALE_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) return { sessions: [], status: "unavailable", skippedSessions: 0, generatedAtMs: now() };
      const parsed = parseTokscaleOutput(result.stdout);
      return {
        sessions: parsed.sessions,
        status: parsed.status,
        skippedSessions: parsed.skippedSessions,
        generatedAtMs: now(),
      };
    } catch {
      return { sessions: [], status: "unavailable", skippedSessions: 0, generatedAtMs: now() };
    }
  }

  function getOrStartReport(key: string, window: LedgerWindow): Promise<ReportResult> {
    const existing = reportInFlight.get(key);
    if (existing) return existing;
    const task = executeReport(window).finally(() => {
      reportInFlight.delete(key);
    });
    reportInFlight.set(key, task);
    return task;
  }

  function startBootstrapAndReport(key: string, request: SummaryRequest): void {
    const task = bootstrap(deps.cliHome)
      .then(() => getOrStartReport(key, request.window))
      .then((report) => {
        cache.set(key, { report, expiresAt: now() + CACHE_TTL_MS });
      })
      // 설치 실패는 캐시하지 않는다. 다음 요청이 즉시 새 bootstrap을 시작해야 한다.
      .catch(() => {})
      .finally(() => {
        bootstrapPending.delete(key);
      });
    bootstrapPending.set(key, task);
  }

  return {
    async getSummary(request) {
      const key = cacheKey(request);
      if (request.refresh) cache.delete(key);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return summaryFromReport(request, cached.report);
      cache.delete(key);
      if (bootstrapPending.has(key)) return statusDto(request, "bootstrapping");

      if (!await isInstalled(deps.cliHome)) {
        if (bootstrapPending.has(key)) return statusDto(request, "bootstrapping");
        startBootstrapAndReport(key, request);
        return statusDto(request, "bootstrapping");
      }

      const report = await getOrStartReport(key, request.window);
      cache.set(key, { report, expiresAt: now() + CACHE_TTL_MS });
      return summaryFromReport(request, report);
    },
  };
}
