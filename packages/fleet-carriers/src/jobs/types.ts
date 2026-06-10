export type CarrierJobsAction = "status" | "result" | "cancel" | "list";
export type CarrierJobsFormat = "summary" | "full";

export interface CarrierJobsParams {
  action: CarrierJobsAction;
  format?: CarrierJobsFormat;
  job_id?: string;
}

export interface CarrierJobsAvailability {
  summary_available: boolean;
  full_available: boolean;
  full_invalidated: boolean;
}

/** 종료된 job의 최종 상태 3값 — kind/status 사본의 단일 소유자 */
export type CarrierJobFinalStatus = "done" | "error" | "aborted";

export type CarrierJobStatus = "active" | CarrierJobFinalStatus;

export type ArchiveBlockKind = "text" | "thought" | "tool_call";

export interface ArchiveBlock {
  kind: ArchiveBlockKind;
  timestamp: number;
  source: string;
  label?: string;
  text?: string;
  title?: string;
  status?: string;
  rawOutput?: string;
  toolCallId?: string;
}

export interface JobArchive {
  jobId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  finalizedAt?: number;
  status: CarrierJobStatus;
  truncated: boolean;
  totalBytes: number;
  blocks: ArchiveBlock[];
  mergeIndex?: Map<string, number>;
}

export interface CarrierJobBase {
  jobId: string;
  tool: `carrier_${string}`;
  status: CarrierJobStatus;
  startedAt: number;
  finishedAt?: number;
  carriers: string[];
  error?: string;
}

export interface CarrierJobSummary extends CarrierJobBase {
  summary: string;
  workspaceChanges?: WorkspaceChangeManifest;
}

export interface WorkspaceChangeManifest {
  attribution: "window-approximate";
  available: boolean;
  reason?: string;
  changes: WorkspaceChangeManifestEntry[];
  statLine: string;
  truncated: boolean;
}

export interface WorkspaceChangeManifestEntry {
  status: string;
  path: string;
}

export type CarrierJobRecord = CarrierJobBase;

export interface CarrierJobLaunchResponse {
  job_id: string;
  accepted: boolean;
  error?: string;
}

export type CarrierJobKind = "carrier" | "sortie" | "taskforce";

export interface ParsedCarrierJobId {
  kind: CarrierJobKind;
  toolCallId: string;
}

export interface FinalStatusInput {
  readonly status: CarrierJobFinalStatus;
}

export interface JobSummaryOptions {
  readonly jobId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly carriers: readonly string[];
  readonly results: readonly FinalStatusInput[];
  readonly status: CarrierJobStatus;
  readonly error?: string;
  readonly tool: `carrier_${string}`;
  readonly prefix: string;
  readonly workspaceChanges?: WorkspaceChangeManifest;
}

export const CARRIER_JOB_TTL_MS = 3 * 60 * 60 * 1000;
export const CARRIER_JOBS_FULL_RESULT_BYTE_CAP = 20_000;
export const CARRIER_JOBS_PER_SUBOP_BYTE_CAP = 20_000;
export const CARRIER_JOBS_GLOBAL_BYTE_CAP = 60_000;

export const JOB_LAUNCH_NOTICE = [
  "Job accepted from carrier_dispatch; result arrives later via carrier-completion follow-up push tagged [carrier:result].",
  "Task Force is an execution mode of carrier_dispatch when the selected carrier is configured for it.",
  "DO NOT poll carrier_jobs.",
].join(" ");

const JOB_PREFIXES = new Set<CarrierJobKind>(["carrier", "sortie", "taskforce"]);

export function formatLaunchResponseText(response: unknown, accepted: boolean): string {
  const payload = JSON.stringify(response);
  if (!accepted) return payload;
  return JOB_LAUNCH_NOTICE + "\n" + payload;
}

export function computeFinalStatus(results: readonly FinalStatusInput[]): CarrierJobStatus {
  if (results.some((result) => result.status === "aborted")) return "aborted";
  if (results.some((result) => result.status === "error")) return "error";
  return "done";
}

export function buildJobSummary(options: JobSummaryOptions): CarrierJobSummary {
  const successCount = options.results.filter((result) => result.status === "done").length;
  const failureCount = options.results.length - successCount;
  return {
    jobId: options.jobId,
    tool: options.tool,
    status: options.status,
    summary: buildJobSummaryText(options.prefix, options.status, successCount, failureCount, options.error),
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    carriers: [...options.carriers],
    error: options.error,
    workspaceChanges: options.workspaceChanges,
  };
}

export function buildCarrierJobId(kind: CarrierJobKind, toolCallId: string): string {
  if (!JOB_PREFIXES.has(kind)) {
    throw new Error(`Unsupported carrier job kind: ${kind}`);
  }
  if (!toolCallId.trim()) {
    throw new Error("toolCallId is required.");
  }
  return `${kind}:${toolCallId}`;
}

export function parseCarrierJobId(jobId: string): ParsedCarrierJobId | null {
  const separatorIndex = jobId.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === jobId.length - 1) return null;
  const prefix = jobId.slice(0, separatorIndex);
  if (!JOB_PREFIXES.has(prefix as CarrierJobKind)) return null;
  return {
    kind: prefix as CarrierJobKind,
    toolCallId: jobId.slice(separatorIndex + 1),
  };
}

export function isCarrierJobId(jobId: string): boolean {
  return parseCarrierJobId(jobId) !== null;
}

function buildJobSummaryText(
  prefix: string,
  status: CarrierJobStatus,
  successCount: number,
  failureCount: number,
  error?: string,
): string {
  if (status === "aborted") return `${prefix} aborted: ${successCount} done, ${failureCount} failed`;
  if (error) return `${prefix} failed: ${error}`;
  return `${prefix} completed: ${successCount} done, ${failureCount} failed`;
}
