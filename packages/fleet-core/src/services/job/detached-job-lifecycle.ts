import {
  acquireJobPermit,
  type JobPermitAccepted,
} from "./concurrency-guard.js";
import {
  registerJobAbortController,
  unregisterJobAbortControllers,
} from "./job-cancel-registry.js";
import { buildCarrierJobId } from "./job-id.js";
import {
  createJobArchive,
  finalizeJobArchive,
} from "./job-stream-archive.js";
import {
  formatLaunchResponseText,
} from "./job-reminders.js";
import type {
  CarrierJobLaunchResponse,
  CarrierJobSummary,
} from "./job-types.js";
import { putJobSummary } from "./lru-cache.js";
import { combineAbortSignals } from "./abort-signals.js";

export type DetachedJobKind = "sortie" | "squadron" | "taskforce";

export type DetachedJobFinalStatus = "done" | "error" | "aborted";

export interface DetachedJobAccepted {
  accepted: true;
  jobId: string;
  permit: JobPermitAccepted;
  signal: AbortSignal;
}

export interface DetachedJobRejected {
  accepted: false;
  response: ReturnType<typeof launchResponseResult>;
}

export type DetachedJobLaunch = DetachedJobAccepted | DetachedJobRejected;

export interface StartDetachedJobOptions {
  jobKind: DetachedJobKind;
  toolName: "carriers_sortie" | "carrier_squadron" | "carrier_taskforce";
  toolCallId: string | undefined;
  startedAt: number;
  carrierIds: string[];
  signal: AbortSignal | undefined;
}

export interface FinalizeDetachedJobOptions {
  jobId: string;
  status: DetachedJobFinalStatus;
  error: string | undefined;
  finishedAt: number;
  summary: CarrierJobSummary;
  permit: JobPermitAccepted;
}

export function launchResponseResult(response: CarrierJobLaunchResponse): { content: { type: "text"; text: string }[]; details: CarrierJobLaunchResponse } {
  return {
    content: [{ type: "text", text: formatLaunchResponseText(response, response.accepted) }],
    details: response,
  };
}

export function startDetachedJob(options: StartDetachedJobOptions): DetachedJobLaunch {
  const jobId = buildCarrierJobId(options.jobKind, options.toolCallId ?? "");
  const permit = acquireJobPermit({
    jobId,
    tool: options.toolName,
    status: "active",
    startedAt: options.startedAt,
    carriers: options.carrierIds,
  });
  if (!permit.accepted) {
    const response = permit.error === "carrier busy"
      ? launchResponseResult({ job_id: jobId, accepted: false, error: permit.error, current_job_id: permit.current_job_id })
      : launchResponseResult({ job_id: jobId, accepted: false, error: permit.error });
    return { accepted: false, response };
  }

  createJobArchive(jobId, options.startedAt);
  const jobController = new AbortController();
  registerJobAbortController(jobId, jobController);
  const signal = options.signal
    ? combineAbortSignals([options.signal, jobController.signal])
    : jobController.signal;
  return { accepted: true, jobId, permit, signal };
}

export function finalizeDetachedJob(options: FinalizeDetachedJobOptions): void {
  putJobSummary(options.summary, options.finishedAt);
  finalizeJobArchive(options.jobId, options.status, options.finishedAt);
  unregisterJobAbortControllers(options.jobId);
  options.permit.release({ status: options.status, error: options.error, finishedAt: options.finishedAt });
}
