/**
 * squadron/tool-spec.ts — carrier_squadron 도구 스펙
 *
 * 동일 캐리어 타입의 여러 인스턴스를 병렬로 출격하여 하나의 임무를 분할 처리합니다.
 */

import { getEffort, type CliType } from "@sbluemin/fleet-unified-agent";

import type { AgentToolSpec } from "../agent/types.js";
import type { CarrierJobStatus as StoredCarrierJobStatus, JobPermitAccepted } from "../../infra/job/index.js";
import type { LogOptions } from "../../infra/log/index.js";
import type { ExecResult } from "../agent/executor.js";
import type { ModelEffort } from "../carrier/overlay-types.js";

import {
  appendBlock,
  buildCarrierJobId,
  buildCarrierResultSystemReminder,
  finalizeDetachedJob,
  launchResponseResult,
  sanitizeChunk,
  sanitizeToolLabel,
  startDetachedJob,
  toMessageArchiveBlock,
  toThoughtArchiveBlock,
} from "../../infra/job/index.js";
import { getLogAPI } from "../../infra/log/store.js";
import { executeOneShot } from "../agent/executor.js";
import {
  emitStreamEvent,
  type CarrierJobStatus,
  type TrackMeta,
  type TrackStatus,
} from "../_shared/carrier-job-events.js";
import {
  getActiveSquadronIds,
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  isCarrierOnline,
  isSquadronCarrierEnabled,
  resolveCarrierCliType,
  resolveCarrierDisplayName,
} from "../carrier/framework.js";
import { buildCarrierSystemPrompt } from "../carrier/prompts.js";
import type { CarrierMetadata } from "../carrier/types.js";
import { loadModels } from "../store/index.js";
import {
  SQUADRON_DOCTRINE,
  buildSquadronSchema,
} from "./prompts.js";
import {
  buildSquadronJobSummary,
  buildSquadronRequestKey,
  buildSquadronRunId,
  computeSquadronFinalStatus,
  sanitizeSquadronSubtasks,
  validateSquadronRequestBlocks,
  validateSquadronSubtaskCount,
  validateSquadronSubtaskLimit,
} from "./squadron-execute.js";
import {
  SQUADRON_MAX_INSTANCES,
  type SquadronResult,
  type SquadronState,
} from "./types.js";

interface SquadronBackgroundOptions {
  jobId: string;
  carrierId: string;
  requestKey: string;
  sanitizedSubtasks: Array<{ title: string; request: string }>;
  state: SquadronState;
  signal: AbortSignal | undefined;
  cwd: string;
  carrierConfig: ReturnType<typeof getRegisteredCarrierConfig>;
  permit: JobPermitAccepted;
  startedAt: number;
}

const SQUADRON_LOG_CATEGORY_INVOKE = "fleet-squadron:invoke";
const SQUADRON_LOG_CATEGORY_VALIDATE = "fleet-squadron:validate";
const SQUADRON_LOG_CATEGORY_DISPATCH = "fleet-squadron:dispatch";
const SQUADRON_LOG_CATEGORY_STREAM = "fleet-squadron:stream";
const SQUADRON_LOG_CATEGORY_EXEC = "fleet-squadron:exec";
const SQUADRON_LOG_CATEGORY_RESULT = "fleet-squadron:result";
const SQUADRON_LOG_CATEGORY_ERROR = "fleet-squadron:error";
const squadronStateStore = new Map<string, SquadronState>();

export function buildSquadronToolSpec(): AgentToolSpec | null {
  const allCarriers = getRegisteredOrder();
  if (allCarriers.length < 1) return null;

  const enabledCarriers = getActiveSquadronIds();

  return {
    ...SQUADRON_DOCTRINE,
    parameters: buildSquadronSchema(enabledCarriers),

    async execute(args: unknown, ctx) {
      const t0 = Date.now();
      const cwd = ctx.cwd;
      const params = args as { carrier: string; expected_subtask_count: number; subtasks: Array<{ title: string; request: string }> };
      const { carrier: carrierId, expected_subtask_count, subtasks } = params;
      logDebug(
        SQUADRON_LOG_CATEGORY_INVOKE,
        `execute start carrier=${carrierId} subtasks=${subtasks.length} ids=${subtasks.map((_, index) => `${index}`).join(", ") || "(none)"}`,
      );

      assertRegisteredCarrier(carrierId);
      assertSortieEnabled(carrierId);
      assertSquadronEnabled(carrierId);
      assertSubtaskCount(expected_subtask_count, subtasks.length);
      assertSubtaskLimit(subtasks.length);
      logDebug(
        SQUADRON_LOG_CATEGORY_VALIDATE,
        `validated carrier=${carrierId} expected=${expected_subtask_count} subtasks=${subtasks.length}`,
      );

      const sanitizedSubtasks = sanitizeSquadronSubtasks(subtasks);
      const carrierConfig = getRegisteredCarrierConfig(carrierId);

      // 필수 request-block 검증 — detached job 시작 전
      if (carrierConfig?.carrierMetadata) {
        const blockValidation = validateSquadronRequestBlocks(
          carrierId,
          carrierConfig.carrierMetadata,
          sanitizedSubtasks,
        );
        if (blockValidation) {
          logDebug(
            SQUADRON_LOG_CATEGORY_ERROR,
            `request-block validation failed carrier=${carrierId} subtask=${blockValidation.subtaskIndex} missing=${blockValidation.missing.join(",")}`,
          );
          const jobId = buildCarrierJobId("squadron", ctx.toolCallId ?? "");
          return launchResponseResult({
            job_id: jobId,
            accepted: false,
            error: blockValidation.error,
          });
        }
      }

      const launch = startDetachedJob({
        jobKind: "squadron",
        toolName: "carrier_squadron",
        toolCallId: ctx.toolCallId,
        startedAt: t0,
        carrierIds: [carrierId],
        signal: ctx.signal,
      });
      if (!launch.accepted) return launch.response;

      const requestKey = buildSquadronRequestKey(carrierId, sanitizedSubtasks);
      const state = initSquadronState(carrierId, requestKey, sanitizedSubtasks);
      emitSquadronJobRegistered(launch.jobId, carrierId, requestKey, sanitizedSubtasks, t0);

      void runSquadronJobInBackground({
        jobId: launch.jobId,
        carrierId,
        requestKey,
        sanitizedSubtasks,
        state,
        signal: launch.signal,
        cwd,
        carrierConfig,
        permit: launch.permit,
        startedAt: t0,
      });

      logDebug(SQUADRON_LOG_CATEGORY_RESULT, `carrier=${carrierId} accepted job=${launch.jobId}`);
      return launchResponseResult({ job_id: launch.jobId, accepted: true });
    },
  };
}

async function runSquadronJobInBackground(opts: SquadronBackgroundOptions): Promise<void> {
  let finalStatus: CarrierJobStatus = "done";
  let finalError: string | undefined;
  let results: SquadronResult[] = [];
  try {
    const cliType = opts.carrierConfig
      ? resolveCarrierCliType(opts.carrierId, opts.carrierConfig.defaultCliType)
      : (opts.carrierId as CliType);
    const modelConfig = loadModels({ [opts.carrierId]: cliType })[opts.carrierId];
    const settledResults = await Promise.allSettled(
      opts.sanitizedSubtasks.map((subtask, index) =>
        runSquadronInstance(index, subtask.title, subtask.request, {
          carrierId: opts.carrierId,
          cliType,
          modelConfig,
          carrierMetadata: opts.carrierConfig?.carrierMetadata,
          state: opts.state,
          signal: opts.signal,
          cwd: opts.cwd,
          requestKey: opts.requestKey,
          jobId: opts.jobId,
        }),
      ),
    );
    opts.state.finishedAt = Date.now();
    results = collectSquadronResults(settledResults, opts.sanitizedSubtasks);
    finalStatus = computeSquadronFinalStatus(results) as CarrierJobStatus;
    logDebug(
      SQUADRON_LOG_CATEGORY_RESULT,
      `carrier=${opts.carrierId} success=${results.filter((r) => r.status === "done").length} failure=${results.filter((r) => r.status !== "done").length}`,
    );
  } catch (error) {
    finalStatus = "error";
    finalError = error instanceof Error ? error.message : String(error);
  } finally {
    const finishedAt = Date.now();
    const summary = buildSquadronJobSummary(opts.jobId, opts.startedAt, finishedAt, opts.carrierId, results, finalStatus as StoredCarrierJobStatus, finalError);
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
        kind: "squadron",
        status: finalStatus as StoredCarrierJobStatus,
        summary,
        error: finalError,
        label: `${opts.sanitizedSubtasks.length} subtasks`,
      }),
    });
    clearSquadronState(opts.requestKey);
    logDebug(SQUADRON_LOG_CATEGORY_INVOKE, `execute end carrier=${opts.carrierId} elapsedMs=${finishedAt - opts.startedAt}`);
  }
}

async function runSquadronInstance(
  index: number,
  title: string,
  request: string,
  opts: {
    carrierId: string;
    cliType: CliType;
    modelConfig: { model?: string; effort?: string } | undefined;
    carrierMetadata: CarrierMetadata | undefined;
    state: SquadronState;
    signal: AbortSignal | undefined;
    cwd: string;
    requestKey: string;
    jobId: string;
  },
): Promise<SquadronResult> {
  const execStartedAt = Date.now();
  const progress = opts.state.subtasks.get(index)!;
  const trackId = `${opts.jobId}:${index}`;
  progress.status = "connecting";

  const syntheticId = buildSquadronRunId(opts.requestKey, index);
  logDebug(
    SQUADRON_LOG_CATEGORY_DISPATCH,
    [
      `carrier=${opts.carrierId} subtask=${index} model=${opts.modelConfig?.model ?? opts.cliType} promptChars=${request.length} run=${syntheticId}`,
      "----- BEGIN REQUEST -----",
      request,
      "----- END REQUEST -----",
    ].join("\n"),
    { hideFromFooter: true, category: "prompt" },
  );

  emitStreamEvent({
    type: "track:begin",
    jobId: opts.jobId,
    trackId,
    requestPreview: request.trim().split(/\r?\n/, 1)[0],
  });

  try {
    const effort = resolveValidatedEffort(
      opts.cliType,
      opts.modelConfig?.model,
      opts.modelConfig?.effort,
    );
    const result = await executeOneShot({
      poolKey: syntheticId,
      cliType: opts.cliType,
      request,
      cwd: opts.cwd,
      model: opts.modelConfig?.model,
      effort,
      connectSystemPrompt: buildCarrierSystemPrompt(opts.carrierMetadata),
      signal: opts.signal,
      onStatusChange: (status) => {
        emitTrackStatus(opts.jobId, trackId, status);
      },
      onMessageChunk: (text) => {
        progress.status = "streaming";
        progress.lineCount++;
        const cleanText = sanitizeChunk(text);
        appendBlock(opts.jobId, toMessageArchiveBlock(opts.carrierId, text, `subtask ${index}: ${title}`));
        emitStreamEvent({ type: "track:text", jobId: opts.jobId, trackId, text: cleanText });
      },
      onThoughtChunk: (text) => {
        const cleanText = sanitizeChunk(text);
        appendBlock(opts.jobId, toThoughtArchiveBlock(opts.carrierId, text, `subtask ${index}: ${title}`));
        logDebug(SQUADRON_LOG_CATEGORY_STREAM, `carrier=${opts.carrierId} subtask=${index} type=thought\n${cleanText}`, { hideFromFooter: true });
        emitStreamEvent({ type: "track:thought", jobId: opts.jobId, trackId, text: cleanText });
      },
      onToolCall: (toolTitle, toolStatus, _rawOutput, toolCallId) => {
        progress.status = "streaming";
        progress.toolCallCount++;
        const cleanTitle = sanitizeToolLabel(toolTitle);
        const cleanStatus = sanitizeToolLabel(toolStatus);
        logDebug(SQUADRON_LOG_CATEGORY_STREAM, `carrier=${opts.carrierId} subtask=${index} type=toolCall title=${cleanTitle} status=${cleanStatus}`, { hideFromFooter: true });
        emitStreamEvent({ type: "track:tool", jobId: opts.jobId, trackId, title: cleanTitle, status: cleanStatus, toolCallId });
      },
    });
    progress.status = result.status === "done" ? "done" : "error";
    emitTrackFinalized(opts.jobId, trackId, result);
    logDebug(
      SQUADRON_LOG_CATEGORY_EXEC,
      `carrier=${opts.carrierId} subtask=${index} success=${result.status === "done"} status=${result.status} elapsedMs=${Date.now() - execStartedAt}`,
    );
    return buildSquadronResult(index, title, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitStreamEvent({ type: "track:finalized", jobId: opts.jobId, trackId, status: "err", error: message });
    logDebug(
      SQUADRON_LOG_CATEGORY_EXEC,
      `carrier=${opts.carrierId} subtask=${index} success=false status=error elapsedMs=${Date.now() - execStartedAt}`,
    );
    throw error;
  }
}

function emitSquadronJobRegistered(
  jobId: string,
  carrierId: string,
  requestKey: string,
  subtasks: Array<{ title: string; request: string }>,
  startedAt: number,
): void {
  const tracks: TrackMeta[] = subtasks.map((subtask, index) => ({
    trackId: `${jobId}:${index}`,
    streamKey: buildSquadronRunId(requestKey, index),
    displayCli: carrierId,
    displayName: subtask.title,
    subtitle: resolveCarrierDisplayName(carrierId),
    kind: "subtask",
  }));
  emitStreamEvent({
    type: "job:registered",
    jobId,
    kind: "squadron",
    ownerCarrierId: carrierId,
    label: `${subtasks.length} subtasks`,
    startedAt,
    tracks,
  });
}

function formatCarrierIdForMessage(carrierId: string): string {
  return JSON.stringify(carrierId);
}

function assertRegisteredCarrier(carrierId: string): void {
  const allIds = new Set(getRegisteredOrder());
  if (!allIds.has(carrierId)) {
    const registered = [...allIds].map(formatCarrierIdForMessage).join(", ") || "(none)";
    logDebug(SQUADRON_LOG_CATEGORY_ERROR, `unknown carrier carrier=${carrierId}`);
    throw new Error(`Unknown carrier: ${formatCarrierIdForMessage(carrierId)}. Registered carriers: ${registered}`);
  }
}

function assertSortieEnabled(carrierId: string): void {
  if (isCarrierOnline(carrierId)) return;
  logDebug(SQUADRON_LOG_CATEGORY_ERROR, `carrier=${carrierId} online=false reason=manually disabled`);
  throw new Error(`Carrier ${formatCarrierIdForMessage(carrierId)} is not available for squadron: manually disabled.`);
}

function assertSquadronEnabled(carrierId: string): void {
  if (isSquadronCarrierEnabled(carrierId)) return;
  logDebug(SQUADRON_LOG_CATEGORY_ERROR, `carrier=${carrierId} squadronEnabled=false`);
  throw new Error(
    `Carrier ${formatCarrierIdForMessage(carrierId)} is not enabled for Squadron.\n` +
    `→ Open Carrier Status (Alt+O), select ${formatCarrierIdForMessage(carrierId)}, press S to enable.`,
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

function assertSubtaskCount(expected: number, actual: number): void {
  try {
    validateSquadronSubtaskCount(expected, actual);
  } catch (error) {
    logDebug(SQUADRON_LOG_CATEGORY_ERROR, `subtask count mismatch expected=${expected} actual=${actual}`);
    throw error;
  }
}

function assertSubtaskLimit(count: number): void {
  try {
    validateSquadronSubtaskLimit(count);
  } catch (error) {
    logDebug(
      SQUADRON_LOG_CATEGORY_ERROR,
      count < 1 ? `subtask count invalid count=${count}` : `subtask count over limit count=${count} max=${SQUADRON_MAX_INSTANCES}`,
    );
    throw error;
  }
}

function buildSquadronResult(
  index: number,
  title: string,
  result: ExecResult,
): SquadronResult {
  return {
    index,
    title,
    status: result.status as "done" | "error" | "aborted",
    responseText: sanitizeChunk(result.responseText) || "(no output)",
    error: result.error ? sanitizeChunk(result.error) : undefined,
    thinking: result.thoughtText ? sanitizeChunk(result.thoughtText) : undefined,
    toolCalls: result.toolCalls.map((toolCall) => ({
      title: sanitizeToolLabel(toolCall.title),
      status: sanitizeToolLabel(toolCall.status),
    })),
  };
}

function collectSquadronResults(
  settledResults: PromiseSettledResult<SquadronResult>[],
  subtasks: Array<{ title: string; request: string }>,
): SquadronResult[] {
  return settledResults.map((settled, index) => {
    if (settled.status === "fulfilled") return settled.value;
    return buildSquadronErrorResult(index, subtasks[index]!.title, settled.reason);
  });
}

function buildSquadronErrorResult(index: number, title: string, reason: unknown): SquadronResult {
  const errorMessage = sanitizeChunk(
    reason instanceof Error ? reason.message : String(reason),
  );
  logDebug(SQUADRON_LOG_CATEGORY_ERROR, `subtask=${index} title=${title} message=${errorMessage}`);
  return {
    index,
    title,
    status: "error",
    responseText: `Error: ${errorMessage}`,
    error: errorMessage,
  };
}

function emitTrackStatus(jobId: string, trackId: string, status: TrackStatus): void {
  emitStreamEvent({ type: "track:status", jobId, trackId, status });
}

function emitTrackFinalized(jobId: string, trackId: string, result: ExecResult): void {
  const status = toCarrierJobStatus(result.status);
  emitStreamEvent({
    type: "track:finalized",
    jobId,
    trackId,
    status: toTrackFinalStatus(status),
    error: status === "aborted" ? "aborted" : result.error,
    fallbackText: sanitizeChunk(result.responseText),
    fallbackThought: sanitizeChunk(result.thoughtText),
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

function initSquadronState(
  carrierId: string,
  requestKey: string,
  subtasks: Array<{ title: string; request: string }>,
): SquadronState {
  const state: SquadronState = {
    carrierId,
    requestKey,
    subtasks: new Map(
      subtasks.map((_, index) => [index, { status: "queued", toolCallCount: 0, lineCount: 0 }]),
    ),
    subtaskTitles: subtasks.map((subtask) => subtask.title),
    startedAt: Date.now(),
  };
  squadronStateStore.set(requestKey, state);
  return state;
}

function clearSquadronState(requestKey: string): void {
  squadronStateStore.delete(requestKey);
}

function logDebug(category: string, message: string, options?: unknown): void {
  getLogAPI().debug(category, message, options as LogOptions | undefined);
}
