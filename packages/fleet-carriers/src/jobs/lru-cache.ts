import { CARRIER_JOB_TTL_MS, type CarrierJobSummary } from "./job-types.js";

interface SummaryCacheState {
  entries: Map<string, CarrierJobSummary>;
  maxEntries: number;
  onEvict?: (jobId: string) => void;
}

export interface JobSummaryCache {
  putJobSummary(summary: CarrierJobSummary, now?: number): void;
  getJobSummary(jobId: string, now?: number): CarrierJobSummary | null;
  listJobSummaries(now?: number): CarrierJobSummary[];
  configureJobSummaryCache(maxEntries: number, onEvict?: (jobId: string) => void): void;
  resetJobSummaryCacheForTest(): void;
}

const DEFAULT_MAX_ENTRIES = 50;

const defaultJobSummaryCache = createJobSummaryCache();

export function createJobSummaryCache(): JobSummaryCache {
  const state: SummaryCacheState = {
    entries: new Map(),
    maxEntries: DEFAULT_MAX_ENTRIES,
  };

  function purgeExpiredSummaries(now: number): void {
    for (const [jobId, entry] of state.entries) {
      const anchor = entry.finishedAt ?? entry.startedAt;
      if (anchor + CARRIER_JOB_TTL_MS <= now) {
        state.entries.delete(jobId);
        state.onEvict?.(jobId);
      }
    }
  }

  return {
    putJobSummary(summary, now = Date.now()) {
      purgeExpiredSummaries(now);
      state.entries.delete(summary.jobId);
      state.entries.set(summary.jobId, summary);
      while (state.entries.size > state.maxEntries) {
        const oldestKey = state.entries.keys().next().value as string | undefined;
        if (!oldestKey) break;
        state.entries.delete(oldestKey);
        state.onEvict?.(oldestKey);
      }
    },
    getJobSummary(jobId, now = Date.now()) {
      purgeExpiredSummaries(now);
      const entry = state.entries.get(jobId) ?? null;
      if (!entry) return null;
      state.entries.delete(jobId);
      state.entries.set(jobId, entry);
      return entry;
    },
    listJobSummaries(now = Date.now()) {
      purgeExpiredSummaries(now);
      return [...state.entries.values()].sort((a, b) => b.startedAt - a.startedAt);
    },
    configureJobSummaryCache(maxEntries, onEvict) {
      state.maxEntries = maxEntries;
      state.onEvict = onEvict;
    },
    resetJobSummaryCacheForTest() {
      state.entries.clear();
      state.maxEntries = DEFAULT_MAX_ENTRIES;
      state.onEvict = undefined;
    },
  };
}

export function putJobSummary(summary: CarrierJobSummary, now = Date.now()): void {
  defaultJobSummaryCache.putJobSummary(summary, now);
}

export function getJobSummary(jobId: string, now = Date.now()): CarrierJobSummary | null {
  return defaultJobSummaryCache.getJobSummary(jobId, now);
}

export function listJobSummaries(now = Date.now()): CarrierJobSummary[] {
  return defaultJobSummaryCache.listJobSummaries(now);
}

export function configureJobSummaryCache(maxEntries: number, onEvict?: (jobId: string) => void): void {
  defaultJobSummaryCache.configureJobSummaryCache(maxEntries, onEvict);
}

export function resetJobSummaryCacheForTest(): void {
  defaultJobSummaryCache.resetJobSummaryCacheForTest();
}
