import os from "node:os";

import {
  type CliExecutor,
  ensureTokscaleBin,
  hasPinnedTokscale,
  TOKSCALE_TIMEOUT_MS,
} from "./cli.js";
import { parseTokscaleModelsOutput, parseTokscaleOutput } from "./parser.js";
import { applyGatewayPricing } from "./pricing.js";
import { buildSummary, EMPTY_MODEL_BREAKDOWN, type ModelBreakdown } from "./summary.js";
import type { LedgerSourceStatus, LedgerSummaryDto, LedgerWindow, TokscaleSession } from "./types.js";

export interface SummaryRequest {
  readonly window: LedgerWindow;
  readonly refresh: boolean;
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
    readonly sessions: readonly TokscaleSession[];
    readonly status: LedgerSourceStatus;
    readonly skippedSessions: number;
    readonly generatedAtMs: number;
  };
  type WindowResult = {
    readonly report: ReportResult;
    readonly models: ModelBreakdown;
  };

  const cache = new Map<string, { readonly expiresAt: number; readonly window: WindowResult }>();
  const bootstrapPending = new Map<string, Promise<void>>();
  const windowInFlight = new Map<string, Promise<WindowResult>>();
  const isInstalled = deps.isInstalled ?? hasPinnedTokscale;
  const bootstrap = deps.bootstrap ?? ensureTokscaleBin;
  const now = deps.now ?? Date.now;

  function summaryFromWindow(request: SummaryRequest, window: WindowResult): LedgerSummaryDto {
    return buildSummary(
      window.report.sessions,
      { window: request.window },
      window.report.status,
      window.report.generatedAtMs,
      window.report.skippedSessions,
      window.models,
    );
  }

  function statusDto(request: SummaryRequest, status: "bootstrapping" | "unavailable"): LedgerSummaryDto {
    return summaryFromWindow(request, {
      report: { sessions: [], status, skippedSessions: 0, generatedAtMs: now() },
      models: { ...EMPTY_MODEL_BREAKDOWN, status },
    });
  }

  async function executeReport(window: LedgerWindow): Promise<ReportResult> {
    const args = ["report", "--json", "--no-summarize", "--client", "claude", `--${window}`];
    try {
      const result = await deps.executor(args, {
        cwd: os.homedir(),
        timeout: TOKSCALE_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        return { sessions: [], status: "unavailable", skippedSessions: 0, generatedAtMs: now() };
      }
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

  async function executeModels(window: LedgerWindow): Promise<ModelBreakdown> {
    const args = [
      "models",
      "--json",
      "--no-spinner",
      "-c",
      "claude",
      "--group-by",
      "client,session,model",
      `--${window}`,
    ];
    try {
      const result = await deps.executor(args, {
        cwd: os.homedir(),
        timeout: TOKSCALE_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) return { entries: [], status: "unavailable", skippedEntries: 0 };
      const parsed = parseTokscaleModelsOutput(result.stdout);
      return {
        entries: parsed.entries.map(applyGatewayPricing),
        status: parsed.status,
        skippedEntries: parsed.skippedEntries,
      };
    } catch {
      return { entries: [], status: "unavailable", skippedEntries: 0 };
    }
  }

  async function executeWindow(window: LedgerWindow): Promise<WindowResult> {
    const [report, models] = await Promise.all([executeReport(window), executeModels(window)]);
    return { report, models };
  }

  function getOrStartWindow(key: string, window: LedgerWindow): Promise<WindowResult> {
    const existing = windowInFlight.get(key);
    if (existing) return existing;
    const task = executeWindow(window).finally(() => {
      windowInFlight.delete(key);
    });
    windowInFlight.set(key, task);
    return task;
  }

  function startBootstrapAndWindow(key: string, request: SummaryRequest): void {
    const task = bootstrap(deps.cliHome)
      .then(() => getOrStartWindow(key, request.window))
      .then((window) => {
        cache.set(key, { window, expiresAt: now() + CACHE_TTL_MS });
      })
      // A failed install is not cached; the next request immediately gets another attempt.
      .catch(() => {})
      .finally(() => {
        bootstrapPending.delete(key);
      });
    bootstrapPending.set(key, task);
  }

  return {
    async getSummary(request) {
      const key = request.window;
      if (request.refresh) cache.delete(key);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return summaryFromWindow(request, cached.window);
      cache.delete(key);
      if (bootstrapPending.has(key)) return statusDto(request, "bootstrapping");

      if (!await isInstalled(deps.cliHome)) {
        if (bootstrapPending.has(key)) return statusDto(request, "bootstrapping");
        startBootstrapAndWindow(key, request);
        return statusDto(request, "bootstrapping");
      }

      const window = await getOrStartWindow(key, request.window);
      cache.set(key, { window, expiresAt: now() + CACHE_TTL_MS });
      return summaryFromWindow(request, window);
    },
  };
}
