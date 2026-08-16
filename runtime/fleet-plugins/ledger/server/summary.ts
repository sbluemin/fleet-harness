import { canonicalModelIdentity, normalizeModelKey } from "./identity.js";
import type {
  LedgerDailyDetailDto,
  LedgerDailyPoint,
  LedgerModelRowDto,
  LedgerSourceStatus,
  LedgerSummaryDto,
  LedgerUsage,
  LedgerWindow,
  TokscaleModelEntry,
  TokscaleSession,
} from "./types.js";

export interface ModelBreakdown {
  readonly entries: readonly TokscaleModelEntry[];
  readonly status: LedgerSourceStatus;
  readonly skippedEntries: number;
}

export const EMPTY_MODEL_BREAKDOWN: ModelBreakdown = {
  entries: [],
  status: "ok",
  skippedEntries: 0,
};

interface Accumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  messages: number;
}

class AggregateOverflowError extends Error {}

const MAX_DAILY_DAYS = 366;
const MAX_MODEL_ROWS = 80;

function emptyAccumulator(): Accumulator {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 };
}

function addFinite(left: number, right: number): number {
  const result = left + right;
  if (!Number.isFinite(result)) throw new AggregateOverflowError("ledger aggregate overflow");
  return result;
}

function addSafeCount(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new AggregateOverflowError("ledger count aggregate overflow");
  return result;
}

function addModelEntry(target: Accumulator, entry: TokscaleModelEntry): void {
  target.input = addSafeCount(target.input, entry.input);
  target.output = addSafeCount(target.output, entry.output);
  target.cacheRead = addSafeCount(target.cacheRead, entry.cacheRead);
  target.cacheWrite = addSafeCount(target.cacheWrite, entry.cacheWrite);
  target.costUsd = addFinite(target.costUsd, entry.costUsd);
  target.messages = addSafeCount(target.messages, entry.messages);
}

function usageOf(value: Accumulator): LedgerUsage {
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
  };
}

export function localDayKey(atMs: number): string {
  const date = new Date(atMs);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateFromDayKey(day: string): Date {
  const date = new Date(0);
  date.setFullYear(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  date.setHours(12, 0, 0, 0);
  return date;
}

function derivedDailyRange(
  window: LedgerWindow,
  generatedAtMs: number,
): { readonly firstDay: string; readonly lastDay: string } {
  const lastDay = localDayKey(generatedAtMs);
  const firstDate = localDateFromDayKey(lastDay);
  if (window === "week") firstDate.setDate(firstDate.getDate() - 6);
  if (window === "month") firstDate.setDate(1);
  return { firstDay: localDayKey(firstDate.getTime()), lastDay };
}

function fillDailyPoints(
  observed: readonly LedgerDailyPoint[],
  derived: { readonly firstDay: string; readonly lastDay: string },
): LedgerDailyPoint[] {
  if (observed.length === 0) return [];
  // Preserve upstream-observed days outside a derived boundary, but cap a malformed or stale span.
  let firstDay = observed[0]!.day < derived.firstDay ? observed[0]!.day : derived.firstDay;
  const observedLastDay = observed[observed.length - 1]!.day;
  const lastDay = observedLastDay > derived.lastDay ? observedLastDay : derived.lastDay;
  const cutoffDate = localDateFromDayKey(lastDay);
  cutoffDate.setDate(cutoffDate.getDate() - (MAX_DAILY_DAYS - 1));
  const cutoffDay = localDayKey(cutoffDate.getTime());
  if (firstDay < cutoffDay) firstDay = cutoffDay;

  const costs = new Map(observed.map((point) => [point.day, point.costUsd]));
  const daily: LedgerDailyPoint[] = [];
  const current = localDateFromDayKey(firstDay);
  while (true) {
    const day = localDayKey(current.getTime());
    daily.push({ day, costUsd: costs.get(day) ?? 0 });
    if (day === lastDay) return daily;
    current.setDate(current.getDate() + 1);
  }
}

function aggregateRows(entries: readonly TokscaleModelEntry[]): LedgerModelRowDto[] {
  const modelMap = new Map<string, {
    identity: ReturnType<typeof canonicalModelIdentity>;
    totals: Accumulator;
  }>();
  for (const entry of entries) {
    const identity = canonicalModelIdentity(entry.modelId);
    const key = normalizeModelKey(entry.modelId);
    const model = modelMap.get(key) ?? { identity, totals: emptyAccumulator() };
    addModelEntry(model.totals, entry);
    modelMap.set(key, model);
  }
  return [...modelMap.values()]
    .map(({ identity, totals }) => ({
      modelId: identity.modelId,
      provider: identity.provider,
      label: identity.label,
      usage: usageOf(totals),
      costUsd: totals.costUsd,
      messages: totals.messages,
    }))
    .sort((a, b) => (
      b.costUsd - a.costUsd
      || b.messages - a.messages
      || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
    ));
}

function buildDailyDetail(day: string, entries: readonly TokscaleModelEntry[]): LedgerDailyDetailDto {
  const totals = emptyAccumulator();
  for (const entry of entries) addModelEntry(totals, entry);
  const models = aggregateRows(entries);
  return {
    day,
    costUsd: totals.costUsd,
    usage: usageOf(totals),
    messages: totals.messages,
    models: models.slice(0, MAX_MODEL_ROWS),
    modelCount: models.length,
  };
}

function emptySummary(
  scope: { readonly window: LedgerWindow },
  generatedAtMs: number,
  source: LedgerSummaryDto["source"],
): LedgerSummaryDto {
  return {
    schemaVersion: 2,
    scope,
    generatedAtMs,
    currentDay: localDayKey(generatedAtMs),
    totals: { ...usageOf(emptyAccumulator()), costUsd: 0, messages: 0 },
    modelRows: [],
    modelCount: 0,
    daily: [],
    dailyDetails: [],
    dailySource: { unmatchedEntries: 0 },
    source,
  };
}

export function buildSummary(
  sessions: readonly TokscaleSession[],
  scope: { readonly window: LedgerWindow },
  reportStatus: LedgerSourceStatus = "ok",
  generatedAtMs = Date.now(),
  skippedSessions = 0,
  modelBreakdown: ModelBreakdown = EMPTY_MODEL_BREAKDOWN,
): LedgerSummaryDto {
  const sourceBase = {
    models: modelBreakdown.status,
    report: reportStatus,
    skippedEntries: modelBreakdown.skippedEntries,
    skippedSessions,
  };
  if (
    modelBreakdown.status === "bootstrapping"
    || modelBreakdown.status === "unavailable"
    || modelBreakdown.status === "unreadable"
  ) {
    return emptySummary(scope, generatedAtMs, {
      status: modelBreakdown.status,
      ...sourceBase,
    });
  }

  try {
    const entries = modelBreakdown.entries;
    const totals = emptyAccumulator();
    for (const entry of entries) addModelEntry(totals, entry);
    const modelRows = aggregateRows(entries);
    const reportCanProvideDates = reportStatus === "ok" || reportStatus === "degraded";
    const status: LedgerSourceStatus = modelBreakdown.status === "degraded" || reportStatus !== "ok"
      ? "degraded"
      : "ok";

    if (!reportCanProvideDates) {
      return {
        schemaVersion: 2,
        scope,
        generatedAtMs,
        currentDay: localDayKey(generatedAtMs),
        totals: { ...usageOf(totals), costUsd: totals.costUsd, messages: totals.messages },
        modelRows: modelRows.slice(0, MAX_MODEL_ROWS),
        modelCount: modelRows.length,
        daily: [],
        dailyDetails: [],
        dailySource: { unmatchedEntries: 0 },
        source: { status, ...sourceBase },
      };
    }

    const sessionDays = new Map(sessions.map((session) => [session.sessionId, localDayKey(session.lastActive)]));
    const entriesByDay = new Map<string, TokscaleModelEntry[]>();
    let unmatchedEntries = 0;
    for (const entry of entries) {
      const day = sessionDays.get(entry.sessionId);
      if (!day) {
        unmatchedEntries += 1;
        continue;
      }
      const entries = entriesByDay.get(day) ?? [];
      entries.push(entry);
      entriesByDay.set(day, entries);
    }

    const dailyDetails = [...entriesByDay.entries()]
      .map(([day, entries]) => buildDailyDetail(day, entries))
      .sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
    const observedDaily = dailyDetails.map(({ day, costUsd }) => ({ day, costUsd }));
    const daily = fillDailyPoints(observedDaily, derivedDailyRange(scope.window, generatedAtMs));

    return {
      schemaVersion: 2,
      scope,
      generatedAtMs,
      currentDay: localDayKey(generatedAtMs),
      totals: { ...usageOf(totals), costUsd: totals.costUsd, messages: totals.messages },
      modelRows: modelRows.slice(0, MAX_MODEL_ROWS),
      modelCount: modelRows.length,
      daily,
      dailyDetails,
      dailySource: { unmatchedEntries },
      source: { status, ...sourceBase },
    };
  } catch (error) {
    if (!(error instanceof AggregateOverflowError)) throw error;
    return emptySummary(scope, generatedAtMs, {
      status: "unreadable",
      models: "unreadable",
      report: reportStatus,
      skippedEntries: modelBreakdown.skippedEntries + modelBreakdown.entries.length,
      skippedSessions,
    });
  }
}
