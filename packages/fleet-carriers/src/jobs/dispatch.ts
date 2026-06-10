import type { AgentToolSpec } from "@dotobokuri/core-mcp-server";

import { Type, type TObject } from "typebox";

import { getFinalized, hasFinalizedJobArchive, hasJobArchive, serializeJobArchive } from "./archive.js";
import { cancelJob, getActiveJob, listActiveJobs } from "./lifecycle.js";
import { getJobSummary, listJobSummaries } from "./summary-cache.js";
import { isCarrierJobId, CARRIER_JOBS_FULL_RESULT_BYTE_CAP, CARRIER_JOBS_GLOBAL_BYTE_CAP, CARRIER_JOBS_PER_SUBOP_BYTE_CAP, type ArchiveBlock, type CarrierJobRecord, type CarrierJobStatus, type CarrierJobSummary, type JobArchive, type CarrierJobsAvailability, type CarrierJobsFormat, type CarrierJobsParams } from "./types.js";

// summary cache / launch-response는 하위 모듈로 분리됨 — 기존 소비자를 위한 동명 re-export
export {
  configureJobSummaryCache,
  createJobSummaryCache,
  getJobSummary,
  listJobSummaries,
  putJobSummary,
  resetJobSummaryCacheForTest,
  type JobSummaryCache,
} from "./summary-cache.js";
export { formatLaunchResponseText, JOB_LAUNCH_NOTICE } from "./types.js";

interface SystemReminderAttributes {
  [key: string]: string;
}

export interface CarrierResultSystemReminderInput {
  jobId: string;
  kind: "carrier" | "taskforce";
  status: CarrierJobStatus;
  summary: CarrierJobSummary;
  error?: string;
  taskforceBackend?: string;
  label?: string;
}

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
  results?: Record<string, string>;
  full_available?: boolean;
  full_invalidated?: boolean;
  retry_after?: string;
  notice?: string;
  summary_available?: boolean;
  cancelled?: boolean;
  error?: string;
}

export const CARRIER_RESULT_PUSH_PREFIX = "[carrier:result]";

export const CARRIER_JOBS_DOCTRINE = {
  id: "carrier_jobs",
  tag: "carrier_jobs",
  title: "carrier_jobs Tool Guidelines",
  description:
    `Lookup and control detached carrier jobs registered by carrier_dispatch.` +
    ` This is not a delegation tool and not a polling tool; use it only to inspect archived output, cancel by job_id, or list jobs.`,
  promptSnippet:
    `carrier_jobs — Lookup/control detached carrier jobs: status, result, cancel, list.`,
  whenToUse: [
    `Use carrier_jobs when a follow-up push is missing, explicit job inspection is required, or the Admiral needs completion metadata, full archived output, cancellation, or a job list.`,
    `Use action:"result" only after the job is finalized; full results remain repeatable for 3 hours.`,
  ],
  whenNotToUse: [
    `Do not use carrier_jobs to delegate new work; use carrier_dispatch.`,
    `Do not request results for active jobs. Results are finalized-only, read-many for 3 hours, and expire by TTL.`,
    `Do not poll, wait-check, or call carrier_jobs merely to see whether a launched job is done; terminal results arrive through the [carrier:result] follow-up push.`,
  ],
  usageGuidelines: [
    `carrier_jobs has exactly four actions: status, result, cancel, list.`,
    `After launch, continue independent work if available; otherwise stop tool use and wait passively for the follow-up push instead of issuing status probes.`,
    `Treat carrier_jobs as the fallback channel for missing pushes or explicit lookups, not as a polling loop.`,
    `Results are finalized-only, read-many for 3h in process memory.`,
    `Task Force dispatch full responses return results: { [cliType]: "..." }; non-Task-Force full responses still return full_result.`,
    `carrier_jobs reads the process-memory summary cache and JobStreamArchive only. It never reads the Agent Panel stream-store.`,
  ],
};

const REMINDER_TEXT_LIMIT = 500;
const REMINDER_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const REMINDER_WHITESPACE = /\s+/g;

const ACTIVE_STATUS_NOTICE =
  "Job is still running. The [carrier:result] push will be delivered automatically when it finishes — do not call carrier_jobs again until that push arrives. Stop calling tools now and return control to the user; the push wakes the agent even after this response ends.";
const ACTIVE_CANCEL_NOTICE =
  "Cancel did not apply: the job is still running normally, not hung. Long-running carrier jobs are expected — do not retry cancel without an explicit user request to abort. The [carrier:result] push will arrive automatically; stop calling tools and return control to the user.";

export function buildCarrierResultSystemReminder(input: CarrierResultSystemReminderInput): string {
  const lines = [`- ${input.jobId}: ${sanitizeReminderText(input.summary.summary)}`];
  const metadata = [
    `kind=${input.kind}`,
    `status=${input.status}`,
    input.label ? `label=${sanitizeReminderText(input.label)}` : undefined,
    input.taskforceBackend ? `backend=${sanitizeReminderText(input.taskforceBackend)}` : undefined,
    input.error ? `error=${sanitizeReminderText(input.error)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  if (metadata.length > 0) lines.push(`  ${metadata.join(" ")}`);
  return wrapSystemReminder(`${CARRIER_RESULT_PUSH_PREFIX}\n${lines.join("\n")}`, { source: "carrier-completion" });
}

export function wrapSystemReminder(text: string, attrs?: SystemReminderAttributes): string {
  const renderedAttrs = renderSystemReminderAttributes(attrs);
  return `<system-reminder${renderedAttrs}>\n${text}\n</system-reminder>`;
}

export function buildCarrierJobsSchema(): TObject {
  return Type.Object({
    action: Type.Unsafe<string>({
      type: "string",
      enum: ["status", "result", "cancel", "list"],
      description: "Job action to perform.",
    }),
    job_id: Type.Optional(Type.String({
      description: "Required for status, result, and cancel. Must be a prefixed job ID such as sortie:<toolCallId>.",
    })),
    format: Type.Optional(Type.Unsafe<string>({
      type: "string",
      enum: ["summary", "full"],
      description: "Optional result detail level for renderers and result lookups.",
    })),
  });
}

export function buildCarrierJobsToolSpec(): AgentToolSpec {
  return {
    ...CARRIER_JOBS_DOCTRINE,
    parameters: buildCarrierJobsSchema(),
    async execute(args: unknown) {
      const result = dispatchCarrierJobsAction(args as CarrierJobsParams);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        isError: false,
        details: result,
      };
    },
  };
}

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

function sanitizeReminderText(text: string): string {
  return escapeXmlText(
    text
      .replace(REMINDER_CONTROL_CHARS, " ")
      .replace(REMINDER_WHITESPACE, " ")
      .trim()
      .slice(0, REMINDER_TEXT_LIMIT),
  );
}

function renderSystemReminderAttributes(attrs?: SystemReminderAttributes): string {
  if (!attrs) return "";
  const pairs = Object.entries(attrs);
  if (pairs.length === 0) return "";
  return pairs.map(([key, value]) => ` ${key}="${escapeXmlAttribute(value)}"`).join("");
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  const isTaskForceJob = jobId.startsWith("taskforce:");
  const isSubOpJob = isTaskForceJob;
  const serializeOpts = isSubOpJob
    ? { perSubOpMaxBytes: CARRIER_JOBS_PER_SUBOP_BYTE_CAP, maxBytes: CARRIER_JOBS_GLOBAL_BYTE_CAP }
    : { maxBytes: CARRIER_JOBS_FULL_RESULT_BYTE_CAP };
  const fullResult = archive ? serializeJobArchive(archive, serializeOpts) : undefined;
  return {
    action: "result",
    format,
    job_id: jobId,
    ok: Boolean(archive),
    status: archive?.status ?? summary?.status ?? "not_found",
    summary: summary ?? undefined,
    ...availability,
    full_result: isTaskForceJob ? undefined : fullResult,
    results: archive && isTaskForceJob ? serializeTaskForceResultsByBackend(archive) : undefined,
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
  if (!isCarrierJobId(jobId)) return "job_id must start with carrier:, sortie:, or taskforce:";
  return null;
}

function normalizeFormat(format: CarrierJobsParams["format"]): CarrierJobsFormat {
  return format === "summary" ? "summary" : "full";
}

function serializeTaskForceResultsByBackend(archive: JobArchive): Record<string, string> {
  const grouped = new Map<string, ArchiveBlock[]>();
  const orderedKeys: string[] = [];
  for (const block of archive.blocks) {
    if (!block.label) continue;
    if (!grouped.has(block.label)) {
      grouped.set(block.label, []);
      orderedKeys.push(block.label);
    }
    grouped.get(block.label)!.push(block);
  }

  const results: Record<string, string> = {};
  for (const cliType of orderedKeys) {
    const blocks = grouped.get(cliType)!;
    results[cliType] = serializeJobArchive(
      { ...archive, blocks },
      { maxBytes: CARRIER_JOBS_PER_SUBOP_BYTE_CAP },
    );
  }
  return results;
}
