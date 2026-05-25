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

export type CarrierJobStatus = "active" | "done" | "error" | "aborted";

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
}

export type CarrierJobRecord = CarrierJobBase;

export interface CarrierJobLaunchResponse {
  job_id: string;
  accepted: boolean;
  error?: string;
}

export const CARRIER_JOB_TTL_MS = 3 * 60 * 60 * 1000;
export const CARRIER_JOBS_FULL_RESULT_BYTE_CAP = 20_000;
export const CARRIER_JOBS_PER_SUBOP_BYTE_CAP = 20_000;
export const CARRIER_JOBS_GLOBAL_BYTE_CAP = 60_000;

export type CarrierJobKind = "carrier" | "sortie" | "taskforce";

export interface ParsedCarrierJobId {
  kind: CarrierJobKind;
  toolCallId: string;
}

const JOB_PREFIXES = new Set<CarrierJobKind>(["carrier", "sortie", "taskforce"]);

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
