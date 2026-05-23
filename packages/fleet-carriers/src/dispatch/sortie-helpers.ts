import type { CarrierJobStatus, CarrierJobSummary } from "@sbluemin/fleet-infra/job";

export interface CarrierSortieOutcome {
  readonly carrierId: string;
  readonly status: "done" | "error" | "aborted";
}

export function computeSortieFinalStatus(results: readonly CarrierSortieOutcome[]): CarrierJobStatus {
  if (results.some((result) => result.status === "aborted")) return "aborted";
  if (results.some((result) => result.status === "error")) return "error";
  return "done";
}

export function buildSortieSummaryText(
  status: CarrierJobStatus,
  successCount: number,
  failureCount: number,
  error?: string,
): string {
  if (status === "aborted") return `carrier job aborted: ${successCount} done, ${failureCount} failed`;
  if (error) return `carrier job failed: ${error}`;
  return `carrier job completed: ${successCount} done, ${failureCount} failed`;
}

export function buildSortieJobSummary(
  jobId: string,
  startedAt: number,
  finishedAt: number,
  assignments: readonly { carrier: string; request: string }[],
  results: readonly CarrierSortieOutcome[],
  status: CarrierJobStatus,
  error: string | undefined,
  tool: string,
): CarrierJobSummary {
  const successCount = results.filter((result) => result.status === "done").length;
  const failureCount = results.length - successCount;
  return {
    jobId,
    tool: tool as CarrierJobSummary["tool"],
    status,
    summary: buildSortieSummaryText(status, successCount, failureCount, error),
    startedAt,
    finishedAt,
    carriers: assignments.map((assignment) => assignment.carrier),
    error,
  };
}
