import { CARRIER_JOB_TTL_MS, type CarrierJobSummary } from "./job-types.js";

interface SummaryCacheState {
  entries: Map<string, CarrierJobSummary>;
  maxEntries: number;
  onEvict?: (jobId: string) => void;
}

const SUMMARY_CACHE_KEY = "__pi_fleet_job_summary_cache__";
const DEFAULT_MAX_ENTRIES = 50;

export function putJobSummary(summary: CarrierJobSummary, now = Date.now()): void {
  const state = getSummaryCacheState();
  purgeExpiredSummaries(now);
  state.entries.delete(summary.jobId);
  state.entries.set(summary.jobId, summary);
  while (state.entries.size > state.maxEntries) {
    const oldestKey = state.entries.keys().next().value as string | undefined;
    if (!oldestKey) break;
    state.entries.delete(oldestKey);
    state.onEvict?.(oldestKey);
  }
}

export function getJobSummary(jobId: string, now = Date.now()): CarrierJobSummary | null {
  purgeExpiredSummaries(now);
  const entry = getSummaryCacheState().entries.get(jobId) ?? null;
  if (!entry) return null;
  getSummaryCacheState().entries.delete(jobId);
  getSummaryCacheState().entries.set(jobId, entry);
  return entry;
}

export function listJobSummaries(now = Date.now()): CarrierJobSummary[] {
  purgeExpiredSummaries(now);
  return [...getSummaryCacheState().entries.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function configureJobSummaryCache(maxEntries: number, onEvict?: (jobId: string) => void): void {
  const state = getSummaryCacheState();
  state.maxEntries = maxEntries;
  state.onEvict = onEvict;
}

export function resetJobSummaryCacheForTest(): void {
  const state = getSummaryCacheState();
  state.entries.clear();
  state.maxEntries = DEFAULT_MAX_ENTRIES;
  state.onEvict = undefined;
}

function purgeExpiredSummaries(now: number): void {
  const state = getSummaryCacheState();
  for (const [jobId, entry] of state.entries) {
    const anchor = entry.finishedAt ?? entry.startedAt;
    if (anchor + CARRIER_JOB_TTL_MS <= now) {
      state.entries.delete(jobId);
      state.onEvict?.(jobId);
    }
  }
}

function getSummaryCacheState(): SummaryCacheState {
  const root = globalThis as Record<string, unknown>;
  const existing = root[SUMMARY_CACHE_KEY] as SummaryCacheState | undefined;
  if (existing) return existing;
  const state: SummaryCacheState = {
    entries: new Map(),
    maxEntries: DEFAULT_MAX_ENTRIES,
  };
  root[SUMMARY_CACHE_KEY] = state;
  return state;
}
