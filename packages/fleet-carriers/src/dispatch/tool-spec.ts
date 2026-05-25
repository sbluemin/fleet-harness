/**
 * carrier/tool-spec.ts — carrier_dispatch 단일 도구 스펙
 *
 * 모든 캐리어를 단일 carrier_dispatch 도구로 통합합니다.
 */

import { Type } from "typebox";
import { getEffort, type CliType } from "@dotobokuri/fleet-unified-agent";

import type { AgentToolSpec } from "@dotobokuri/fleet-mcp-server";
import type { CarrierJobStatus as StoredCarrierJobStatus, JobPermitAccepted } from "../jobs/index.js";
import type { LogOptions } from "@dotobokuri/fleet-infra/log";
import type { ModelEffort } from "./overlay-types.js";

import {
  appendBlock,
  buildCarrierResultSystemReminder,
  buildCarrierJobId,
  finalizeDetachedJob,
  launchResponseResult,
  sanitizeChunk,
  sanitizeToolLabel,
  startDetachedJob,
  toMessageArchiveBlock,
  toThoughtArchiveBlock,
} from "../jobs/index.js";
import { getLogAPI } from "@dotobokuri/fleet-infra/log";
import {
  emitStreamEvent,
  type CarrierJobStatus,
  type TrackMeta,
  type TrackStatus,
} from "../stream/stream-events.js";
import { executeWithPool } from "@dotobokuri/fleet-infra/agent";
import {
  getConfiguredTaskForceBackends,
  loadModels,
} from "../store/index.js";
import { launchTaskForceJob } from "./taskforce-launch.js";
import {
  buildCarrierSystemPrompt,
  CARRIER_REQUEST_BREVITY_GUIDELINE,
} from "./prompts.js";
import {
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  resolveCarrierCliType,
  resolveCarrierDisplayName,
  type CarrierRegistry,
} from "./framework.js";
import { validateRequiredRequestBlocks } from "./request-blocks.js";
import {
  buildSortieJobSummary,
} from "./sortie-helpers.js";

// ═════════════════════════════════════════════════════════
// Types / Interfaces
// ═════════════════════════════════════════════════════════

interface CarrierSingleResult {
  carrierId: string;
  displayName: string;
  status: CarrierJobStatus;
  responseText: string;
  sessionId?: string;
  error?: string;
  thinking?: string;
  toolCalls?: { title: string; status: string }[];
}

interface CarrierBackgroundOptions {
  registry: CarrierRegistry;
  jobId: string;
  carrierId: string;
  label: string;
  request: string;
  signal: AbortSignal | undefined;
  cwd: string;
  permit: JobPermitAccepted;
  startedAt: number;
  toolName: `carrier_${string}`;
}

// ═════════════════════════════════════════════════════════
// Constants
// ═════════════════════════════════════════════════════════

const CARRIER_LOG_CATEGORY_INVOKE = "fleet-carrier:invoke";
const CARRIER_LOG_CATEGORY_DISPATCH = "fleet-carrier:dispatch";
const CARRIER_LOG_CATEGORY_STREAM = "fleet-carrier:stream";
const CARRIER_LOG_CATEGORY_EXEC = "fleet-carrier:exec";
const CARRIER_LOG_CATEGORY_RESULT = "fleet-carrier:result";
const CARRIER_LOG_CATEGORY_ERROR = "fleet-carrier:error";

// ═════════════════════════════════════════════════════════
// 공개 빌더
// ═════════════════════════════════════════════════════════

/**
 * 모든 캐리어를 단일 carrier_dispatch 도구로 통합한 AgentToolSpec을 반환합니다.
 */
export function buildCarrierDispatchToolSpec(registry: CarrierRegistry): AgentToolSpec {
  return {
    id: "carrier_dispatch",
    tag: "carrier_dispatch",
    title: "Carrier Dispatch Tool Guidelines",
    description:
      `Register a fire-and-forget carrier job for the specified carrier.` +
      ` Returns a job_id immediately; results arrive through [carrier:result] push; carrier_jobs is fallback/explicit lookup only.`,
    promptSnippet:
      `carrier_dispatch — Register a carrier job for task delegation to a named carrier.` +
      ` Results arrive later via [carrier:result]; carrier_jobs is fallback/explicit lookup only.`,
    whenToUse: [
      `See <fleet section="roster"> for carrier selection and routing guidance.`,
    ],
    whenNotToUse: [],
    usageGuidelines: [
      `Every carrier_dispatch call MUST include label: a concise one-line dispatch intent, not the carrier name and not the full request.` +
        ` Missing, empty, or non-string label is rejected before launch.`,
      `When composing a request, provide only background, context, objective, and constraints.` +
        ` Do NOT prescribe implementation details or step-by-step instructions — trust the carrier's own reasoning.` +
        ` Launch response schema is { job_id, accepted, error? } and never includes synchronous result content.` +
        ` Full output is available only through carrier_jobs(action:"result", format:"full"), is finalized-only, and remains read-many for 3h.`,
      `Do not poll, wait-check, or call carrier_jobs merely to see whether the job is done.` +
        ` Continue independent work if available; otherwise stop tool use and wait passively for the [carrier:result] follow-up push.`,
      `Some carriers require structured request blocks (e.g., <objective>, <context>).` +
        ` See <fleet section="roster"> for each carrier's required and optional tags.` +
        ` Missing required tags cause hard-error rejection by the dispatcher.`,
      CARRIER_REQUEST_BREVITY_GUIDELINE,
    ],
    guardrails: [
      `Multiple agents may be working on this codebase at the same time on a single filesystem and branch.` +
        ` Only touch changes you made — never revert or overwrite modifications made by others.` +
        ` Prefer precise edits (edit) over full-file writes (write).` +
        ` Always re-read a file before modifying it, as it may have changed since your last read.`,
    ],
    get parameters() {
      const carrierIds = getRegisteredOrder(registry);
      const blockLines = carrierIds
        .map((carrierId) => {
          const config = getRegisteredCarrierConfig(registry, carrierId);
          const required = config?.carrierMetadata?.requestBlocks.filter((b) => b.required) ?? [];
          if (required.length === 0) return null;
          return `${carrierId}: ${required.map((b) => `<${b.tag}>`).join(", ")}`;
        })
        .filter((line): line is string => line !== null);
      const requestDesc = blockLines.length > 0
        ? `The task/prompt to send to the carrier. Per-carrier required blocks — ${blockLines.join("; ")}. Missing blocks cause hard-error rejection.`
        : "The task/prompt to send to the carrier.";
      return Type.Object({
        carrier_id: Type.String({
          enum: carrierIds,
          description: `The target carrier ID to dispatch the job to. See <fleet section="roster"> for available carriers.`,
        }),
        label: Type.String({
          description: `Required concise one-line dispatch intent label. Describe the work intent, e.g. "Audit panel run identity"; do not use the carrier name and do not paste the full request.`,
        }),
        request: Type.String({ description: requestDesc }),
      });
    },

    async execute(args: unknown, ctx) {
      const t0 = Date.now();
      const cwd = ctx.cwd;
      const toolCallId = ctx.toolCallId ?? "";
      const jobId = buildCarrierJobId("carrier", toolCallId);
      const toolName: `carrier_${string}` = "carrier_dispatch";

      if (!isDispatchArgs(args)) {
        return launchResponseResult({
          job_id: jobId,
          accepted: false,
          error: "Invalid arguments: carrier_id, label, and request must be non-empty strings.",
        });
      }

      const carrierId = args.carrier_id.trim();
      const label = args.label.trim();
      const request = args.request;

      logDebug(
        CARRIER_LOG_CATEGORY_INVOKE,
        `execute start carrier=${carrierId}`,
      );

      const config = getRegisteredCarrierConfig(registry, carrierId);
      if (!config) {
        logDebug(CARRIER_LOG_CATEGORY_ERROR, `carrier not registered carrier=${carrierId}`);
        return launchResponseResult({
          job_id: jobId,
          accepted: false,
          error: `Carrier "${carrierId}" is not registered.`,
        });
      }

      const metadata = config.carrierMetadata;

      // 필수 request-block 검증
      if (metadata) {
        const blockValidation = validateRequiredRequestBlocks(metadata, request, carrierId);
        if (!blockValidation.ok) {
          logDebug(CARRIER_LOG_CATEGORY_ERROR, `request-block validation failed carrier=${carrierId}`);
          return launchResponseResult({
            job_id: jobId,
            accepted: false,
            error: blockValidation.error,
          });
        }
      }

      if (getConfiguredTaskForceBackends(carrierId).length >= 2) {
        return launchTaskForceJob({
          registry,
          carrierId,
          request,
          label,
          startedAt: t0,
          toolName,
          ctx,
        });
      }

      const launch = startDetachedJob({
        jobKind: "carrier",
        toolName,
        toolCallId,
        startedAt: t0,
        carrierIds: [carrierId],
        signal: ctx.signal,
      });
      if (!launch.accepted) return launch.response;

      emitJobRegistered(registry, jobId, carrierId, toolCallId, label, t0);

      void runCarrierJobInBackground({
        registry,
        jobId,
        carrierId,
        label,
        request,
        signal: launch.signal,
        cwd,
        permit: launch.permit,
        startedAt: t0,
        toolName,
      });

      logDebug(CARRIER_LOG_CATEGORY_RESULT, `carrier=${carrierId} accepted job=${jobId}`);
      return launchResponseResult({ job_id: jobId, accepted: true });
    },
  };
}

// ═════════════════════════════════════════════════════════
// 내부 헬퍼
// ═════════════════════════════════════════════════════════

async function runCarrierJobInBackground(opts: CarrierBackgroundOptions): Promise<void> {
  let finalStatus: CarrierJobStatus = "done";
  let finalError: string | undefined;
  let result: CarrierSingleResult | undefined;
  try {
    result = await runSingleCarrier(opts);
    finalStatus = result.status;
    logDebug(
      CARRIER_LOG_CATEGORY_RESULT,
      `carrier=${opts.carrierId} status=${finalStatus}`,
    );
  } catch (error) {
    finalStatus = "error";
    finalError = error instanceof Error ? error.message : String(error);
  } finally {
    const finishedAt = Date.now();
    const assignments = [{ carrier: opts.carrierId, request: opts.request }];
    const results = result
      ? [result]
      : [{ carrierId: opts.carrierId, displayName: resolveCarrierDisplayName(opts.registry, opts.carrierId), status: "error" as CarrierJobStatus, responseText: finalError ?? "Unknown error", error: finalError }];
    const summary = buildSortieJobSummary(
      opts.jobId, opts.startedAt, finishedAt,
      assignments, results, finalStatus as StoredCarrierJobStatus, finalError, opts.toolName,
    );
    finalizeDetachedJob({
      jobId: opts.jobId,
      status: finalStatus,
      error: finalError,
      finishedAt,
      summary,
      permit: opts.permit,
    });
    emitStreamEvent({
      type: "job:finalized",
      jobId: opts.jobId,
      status: finalStatus,
      finishedAt,
      error: finalError,
      summary: summary.summary,
      systemReminder: buildCarrierResultSystemReminder({
        jobId: opts.jobId,
        kind: "carrier",
        status: finalStatus as StoredCarrierJobStatus,
        summary,
        error: finalError,
        label: opts.label,
      }),
    });
    logDebug(CARRIER_LOG_CATEGORY_INVOKE, `execute end carrier=${opts.carrierId} elapsedMs=${finishedAt - opts.startedAt}`);
  }
}

async function runSingleCarrier(opts: CarrierBackgroundOptions): Promise<CarrierSingleResult> {
  const execStartedAt = Date.now();
  const carrierConfig = getRegisteredCarrierConfig(opts.registry, opts.carrierId);
  const cliType = carrierConfig
    ? resolveCarrierCliType(opts.carrierId, carrierConfig.defaultCliType)
    : (opts.carrierId as CliType);
  const modelConfig = loadModels({ [opts.carrierId]: cliType })[opts.carrierId];
  const model = modelConfig?.model;
  const effort = resolveValidatedEffort(cliType, model, modelConfig?.effort);
  let sessionId: string | undefined;

  logDebug(
    CARRIER_LOG_CATEGORY_DISPATCH,
    [
      `carrier=${opts.carrierId} model=${model ?? cliType} effort=${effort ?? "(none)"} promptChars=${opts.request.length}`,
      "----- BEGIN REQUEST -----",
      opts.request,
      "----- END REQUEST -----",
    ].join("\n"),
    { hideFromFooter: true, category: "prompt" },
  );

  emitStreamEvent({
    type: "track:begin",
    jobId: opts.jobId,
    trackId: opts.carrierId,
    requestPreview: opts.request.trim().split(/\r?\n/, 1)[0],
  });

  try {
    const execResult = await executeWithPool({
      poolKey: opts.carrierId,
      carrierId: opts.carrierId,
      cliType,
      request: opts.request,
      cwd: opts.cwd,
      model,
      effort,
      connectSystemPrompt: buildCarrierSystemPrompt(carrierConfig?.carrierMetadata),
      signal: opts.signal,
      onConnected: (info) => {
        sessionId = info.sessionId;
      },
      onStatusChange: (status) => {
        emitStreamEvent({ type: "track:status", jobId: opts.jobId, trackId: opts.carrierId, status });
      },
      onMessageChunk: (text) => {
        const cleanText = sanitizeChunk(text);
        appendBlock(opts.jobId, toMessageArchiveBlock(opts.carrierId, text));
        emitStreamEvent({ type: "track:text", jobId: opts.jobId, trackId: opts.carrierId, text: cleanText });
      },
      onThoughtChunk: (text) => {
        const cleanText = sanitizeChunk(text);
        appendBlock(opts.jobId, toThoughtArchiveBlock(opts.carrierId, text));
        emitStreamEvent({ type: "track:thought", jobId: opts.jobId, trackId: opts.carrierId, text: cleanText });
      },
      onToolCall: (toolTitle, toolStatus, _rawOutput, toolCallId) => {
        const title = sanitizeToolLabel(toolTitle);
        const status = sanitizeToolLabel(toolStatus);
        logDebug(CARRIER_LOG_CATEGORY_STREAM, `carrier=${opts.carrierId} type=toolCall title=${title} status=${status}`, { hideFromFooter: true });
        emitStreamEvent({ type: "track:tool", jobId: opts.jobId, trackId: opts.carrierId, title, status, toolCallId });
      },
    });
    const finalStatus = toCarrierJobStatus(execResult.status);
    emitStreamEvent({
      type: "track:finalized",
      jobId: opts.jobId,
      trackId: opts.carrierId,
      status: toTrackFinalStatus(finalStatus),
      sessionId,
      fallbackText: sanitizeChunk(execResult.responseText),
      fallbackThought: sanitizeChunk(execResult.thoughtText),
      error: finalStatus === "aborted" ? "aborted" : execResult.error,
    });
    logDebug(CARRIER_LOG_CATEGORY_EXEC, `carrier=${opts.carrierId} success=${execResult.status === "done"} status=${execResult.status} elapsedMs=${Date.now() - execStartedAt}`);
    return {
      carrierId: opts.carrierId,
      displayName: resolveCarrierDisplayName(opts.registry, opts.carrierId),
      status: finalStatus,
      responseText: execResult.responseText || "(no output)",
      sessionId,
      error: execResult.error,
      thinking: execResult.thoughtText,
      toolCalls: execResult.toolCalls.map((tc) => ({ title: tc.title, status: tc.status })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitStreamEvent({
      type: "track:finalized",
      jobId: opts.jobId,
      trackId: opts.carrierId,
      status: "err",
      error: message,
    });
    logDebug(CARRIER_LOG_CATEGORY_EXEC, `carrier=${opts.carrierId} success=false status=error elapsedMs=${Date.now() - execStartedAt}`);
    throw error;
  }
}

function emitJobRegistered(
  registry: CarrierRegistry,
  jobId: string,
  carrierId: string,
  sortieKey: string,
  label: string,
  startedAt: number,
): void {
  const runId = buildCarrierDispatchRunId(jobId, carrierId);
  const tracks: TrackMeta[] = [{
    trackId: carrierId,
    streamKey: carrierId,
    displayCli: carrierId,
    displayName: resolveCarrierDisplayName(registry, carrierId),
    kind: "carrier",
    runId,
  }];
  emitStreamEvent({
    type: "job:registered",
    jobId,
    kind: "carrier",
    ownerCarrierId: carrierId,
    label,
    startedAt,
    activeJobToolCallId: sortieKey,
    tracks,
  });
}

function toCarrierJobStatus(status: TrackStatus): CarrierJobStatus {
  if (status === "done") return "done";
  if (status === "aborted") return "aborted";
  return "error";
}

function toTrackFinalStatus(status: CarrierJobStatus): TrackStatus {
  if (status === "done") return "done";
  if (status === "aborted") return "aborted";
  return "err";
}

function buildCarrierDispatchRunId(jobId: string, carrierId: string): string {
  return `${jobId}:${carrierId}`;
}

function isDispatchArgs(v: unknown): v is { carrier_id: string; label: string; request: string } {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.carrier_id === "string" &&
    obj.carrier_id.trim().length > 0 &&
    typeof obj.label === "string" &&
    obj.label.trim().length > 0 &&
    typeof obj.request === "string" &&
    obj.request.trim().length > 0
  );
}

function resolveValidatedEffort(
  cliType: CliType,
  modelId: string | undefined,
  effort: string | undefined,
): string | undefined {
  if (!modelId || !effort) return undefined;
  const modelEffort = getModelEffort(cliType, modelId);
  if (!modelEffort?.levels?.includes(effort)) return undefined;
  return effort;
}

function getModelEffort(
  cliType: CliType,
  modelId: string,
): ModelEffort | null {
  return normalizeEffort(getEffort(cliType, modelId));
}

function normalizeEffort(
  effort: ModelEffort,
): ModelEffort | null {
  if (!effort.supported) return null;
  const levels = effort.levels ?? [];
  if (levels.length === 0) return null;
  return {
    supported: true,
    levels,
    default: effort.default && levels.includes(effort.default) ? effort.default : levels[0],
  };
}

function logDebug(category: string, message: string, options?: unknown): void {
  getLogAPI().debug(category, message, options as LogOptions | undefined);
}
