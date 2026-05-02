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
  tool: "carriers_sortie" | "carrier_squadron" | "carrier_taskforce";
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
  current_job_id?: string;
}

export const CARRIER_JOB_TTL_MS = 3 * 60 * 60 * 1000;
