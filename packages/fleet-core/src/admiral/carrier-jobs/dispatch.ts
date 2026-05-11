import { getFinalized, hasFinalizedJobArchive, hasJobArchive } from "../../infra/job/job-stream-archive.js";
import { cancelJob } from "../../infra/job/job-cancel-registry.js";
import { getActiveJob, listActiveJobs } from "../../infra/job/concurrency-guard.js";
import { isCarrierJobId } from "../../infra/job/job-id.js";
import { serializeJobArchive } from "../../infra/job/archive-serializer.js";
import { getJobSummary, listJobSummaries } from "../../infra/job/lru-cache.js";
import {
  CARRIER_JOBS_FULL_RESULT_BYTE_CAP,
  CARRIER_JOBS_GLOBAL_BYTE_CAP,
  CARRIER_JOBS_PER_SUBOP_BYTE_CAP,
  type CarrierJobRecord,
  type CarrierJobSummary,
} from "../../infra/job/job-types.js";
import type { CarrierJobsAvailability, CarrierJobsFormat, CarrierJobsParams } from "./types.js";

export interface CarrierJobsResponse {
  action: string;
  format?: CarrierJobsFormat;
  job_id?: string;
  ok: boolean;
  status?: string;
  active?: CarrierJobRecord[];
  recent?: CarrierJobSummary[];
  summary?: CarrierJobSummary;
  full_result?: string;
  full_available?: boolean;
  full_invalidated?: boolean;
  retry_after?: string;
  notice?: string;
  summary_available?: boolean;
  cancelled?: boolean;
  error?: string;
}

const ACTIVE_STATUS_NOTICE =
  "Job is still running. The [carrier:result] push will be delivered automatically when it finishes — do not call carrier_jobs again until that push arrives. Stop calling tools now and return control to the user; the push wakes the agent even after this response ends.";
const ACTIVE_CANCEL_NOTICE =
  "Cancel did not apply: the job is still running normally, not hung. Long-running carrier jobs are expected — do not retry cancel without an explicit user request to abort. The [carrier:result] push will arrive automatically; stop calling tools and return control to the user.";

export function dispatchCarrierJobsAction(params: CarrierJobsParams, now = Date.now()): CarrierJobsResponse {
  if (params.action === "list") {
    return {
      action: "list",
      ok: true,
      active: listActiveJobs(),
      recent: listJobSummaries(now),
    };
  }

  const jobIdError = validateJobId(params.job_id);
  if (jobIdError) {
    return {
      action: params.action,
      job_id: params.job_id,
      ok: false,
      error: jobIdError,
    };
  }

  const jobId = params.job_id!;
  if (params.action === "status") return statusResponse(jobId, now);
  if (params.action === "result") return resultResponse(jobId, normalizeFormat(params.format), now);
  if (params.action === "cancel") return cancelResponse(jobId, now);

  return {
    action: String((params as { action?: unknown }).action),
    job_id: jobId,
    ok: false,
    error: "unsupported action",
  };
}

function statusResponse(jobId: string, now: number): CarrierJobsResponse {
  const active = getActiveJob(jobId);
  const summary = getJobSummary(jobId, now);
  const availability = getAvailability(jobId, summary, now);
  return {
    action: "status",
    job_id: jobId,
    ok: Boolean(active || summary || availability.full_available),
    status: active?.status ?? summary?.status ?? "not_found",
    summary: summary ?? undefined,
    notice: active ? ACTIVE_STATUS_NOTICE : undefined,
    ...availability,
  };
}

function resultResponse(jobId: string, format: CarrierJobsFormat, now: number): CarrierJobsResponse {
  const active = getActiveJob(jobId);
  const summary = getJobSummary(jobId, now);
  const availability = getAvailability(jobId, summary, now);
  if (active) {
    return {
      action: "result",
      format,
      job_id: jobId,
      ok: false,
      status: active.status,
      summary: summary ?? undefined,
      ...availability,
      error: "job not finalized",
      retry_after:
        "do not retry; wait for the [carrier:result] push that will arrive automatically when the job reaches done, error, or aborted.",
      notice: ACTIVE_STATUS_NOTICE,
    };
  }

  if (format === "summary") {
    return {
      action: "result",
      format,
      job_id: jobId,
      ok: Boolean(summary),
      status: summary?.status ?? "not_found",
      summary: summary ?? undefined,
      ...availability,
      error: summary ? undefined : "summary unavailable or expired",
    };
  }

  const archive = getFinalized(jobId, now);
  const isSubOpJob =
    summary?.tool === "carrier_squadron" ||
    summary?.tool === "carrier_taskforce" ||
    jobId.startsWith("squadron:") ||
    jobId.startsWith("taskforce:");
  const serializeOpts = isSubOpJob
    ? { perSubOpMaxBytes: CARRIER_JOBS_PER_SUBOP_BYTE_CAP, maxBytes: CARRIER_JOBS_GLOBAL_BYTE_CAP }
    : { maxBytes: CARRIER_JOBS_FULL_RESULT_BYTE_CAP };
  return {
    action: "result",
    format,
    job_id: jobId,
    ok: Boolean(archive),
    status: archive?.status ?? summary?.status ?? "not_found",
    summary: summary ?? undefined,
    ...availability,
    full_result: archive ? serializeJobArchive(archive, serializeOpts) : undefined,
    error: archive ? undefined : "full result unavailable or expired",
  };
}

function cancelResponse(jobId: string, now: number): CarrierJobsResponse {
  const result = cancelJob(jobId);
  const active = getActiveJob(jobId);
  const summary = getJobSummary(jobId, now);
  return {
    action: "cancel",
    job_id: jobId,
    ok: result.cancelled,
    cancelled: result.cancelled,
    status: result.cancelled ? "cancelled" : active?.status ?? summary?.status ?? "not_found",
    summary: summary ?? undefined,
    notice: !result.cancelled && active ? ACTIVE_CANCEL_NOTICE : undefined,
    ...getAvailability(jobId, summary, now),
    error: result.cancelled ? undefined : "job not found or already finished",
  };
}

function getAvailability(jobId: string, summary: CarrierJobSummary | null, now: number): CarrierJobsAvailability {
  const fullAvailable = hasFinalizedJobArchive(jobId, now);
  return {
    summary_available: Boolean(summary),
    full_available: fullAvailable,
    full_invalidated: !hasJobArchive(jobId, now) && Boolean(summary),
  };
}

function validateJobId(jobId: string | undefined): string | null {
  if (!jobId) return "job_id is required";
  if (!isCarrierJobId(jobId)) return "job_id must start with carrier:, squadron:, or taskforce:";
  return null;
}

function normalizeFormat(format: CarrierJobsParams["format"]): CarrierJobsFormat {
  return format === "summary" ? "summary" : "full";
}
