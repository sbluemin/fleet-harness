import { ApiError } from "./api.js";

export interface KnowledgeReadinessSummary {
  readonly entryCount: number;
  readonly pendingQueueCount: number;
  readonly archivedQueueCount: number;
  readonly openConflictCount: number;
  readonly logEntryCount: number;
  readonly latestLogStatus: "available" | "empty";
}

interface QueueSummaryResponse {
  readonly pendingCount?: number;
  readonly archivedCount?: number;
  readonly items?: readonly unknown[];
}

interface LogSummaryResponse {
  readonly totalEntries?: number;
  readonly entries?: readonly unknown[];
}

export async function fetchKnowledgeReadiness(theaterId: string, signal?: AbortSignal): Promise<KnowledgeReadinessSummary> {
  const [index, queue, conflicts, log] = await Promise.all([
    fetchDashboardJson<readonly unknown[]>(theaterId, "/index", signal),
    fetchDashboardJson<QueueSummaryResponse>(theaterId, "/queue?status=all", signal),
    fetchDashboardJson<readonly unknown[]>(theaterId, "/conflicts", signal),
    fetchDashboardJson<LogSummaryResponse>(theaterId, "/log?limit=3", signal),
  ]);
  return {
    entryCount: Array.isArray(index) ? index.length : 0,
    pendingQueueCount: typeof queue.pendingCount === "number" ? queue.pendingCount : 0,
    archivedQueueCount: typeof queue.archivedCount === "number" ? queue.archivedCount : 0,
    openConflictCount: Array.isArray(conflicts) ? conflicts.length : 0,
    logEntryCount: typeof log.totalEntries === "number" ? log.totalEntries : Array.isArray(log.entries) ? log.entries.length : 0,
    latestLogStatus: Array.isArray(log.entries) && log.entries.length > 0 ? "available" : "empty",
  };
}

async function fetchDashboardJson<T>(theaterId: string, path: string, signal?: AbortSignal): Promise<T> {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const response = await fetch(`/console/codex/w/${encodeURIComponent(theaterId)}/api${normalized}`, { signal });
  if (!response.ok) throw new ApiError(response.status, response.statusText || `HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
