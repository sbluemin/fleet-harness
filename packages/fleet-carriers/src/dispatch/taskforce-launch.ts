/**
 * taskforce/tool-spec.ts — Task Force 내부 실행 지원
 *
 * 선택된 Carrier의 persona를 유지한 채로 설정된 CLI 백엔드들에 동시 실행하여 교차검증합니다.
 */

import { getEffort, type CliType } from "@sbluemin/fleet-unified-agent";

import type { AgentToolCtx, AgentToolSpec } from "@sbluemin/fleet-mcp-server";
import type { CarrierJobStatus as StoredCarrierJobStatus, JobPermitAccepted } from "../job/index.js";
import type { LogOptions } from "@sbluemin/fleet-infra/log";
import type { ExecResult } from "@sbluemin/fleet-infra/agent";
import type { ModelEffort } from "./overlay-types.js";

import {
  CLI_DISPLAY_NAMES,
} from "../constants.js";
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
} from "../job/index.js";
import { getLogAPI } from "@sbluemin/fleet-infra/log";
import { executeOneShot } from "@sbluemin/fleet-infra/agent";
import {
  emitStreamEvent,
  type CarrierJobStatus,
  type TrackMeta,
  type TrackStatus,
} from "../events/stream-events.js";
import {
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  resolveCarrierDisplayName,
  type CarrierRegistry,
} from "./framework.js";
import { buildCarrierSystemPrompt } from "./prompts.js";
import {
  getConfiguredTaskForceBackends,
  getTaskForceModelConfig,
} from "../store/index.js";
import {
  assertTaskForceBackendCount,
  buildTaskForceJobSummary,
  buildTaskForceRequestKey,
  computeTaskForceFinalStatus,
  validateTaskForceRequestBlocks,
} from "./taskforce-helpers.js";
import {
  type TaskForceCliType,
  type TaskForceResult,
  type TaskForceState,
} from "./types.js";

interface TaskForceBackgroundOptions {
  registry: CarrierRegistry;
  jobId: string;
  carrierId: string;
  requestKey: string;
  activeBackends: TaskForceCliType[];
  request: string;
  state: TaskForceState;
  signal: AbortSignal | undefined;
  cwd: string;
  permit: JobPermitAccepted;
  startedAt: number;
  toolName: `carrier_${string}`;
  label: string;
}

export interface TaskForceLaunchOptions {
  registry: CarrierRegistry;
  carrierId: string;
  request: string;
  label: string;
  startedAt: number;
  toolName: `carrier_${string}`;
  ctx: AgentToolCtx;
}

const TASKFORCE_LOG_CATEGORY_INVOKE = "fleet-taskforce:invoke";
const TASKFORCE_LOG_CATEGORY_VALIDATE = "fleet-taskforce:validate";
const TASKFORCE_LOG_CATEGORY_DISPATCH = "fleet-taskforce:dispatch";
const TASKFORCE_LOG_CATEGORY_STREAM = "fleet-taskforce:stream";
const TASKFORCE_LOG_CATEGORY_EXEC = "fleet-taskforce:exec";
const TASKFORCE_LOG_CATEGORY_RESULT = "fleet-taskforce:result";
const TASKFORCE_LOG_CATEGORY_ERROR = "fleet-taskforce:error";
const taskForceStateStore = new Map<string, TaskForceState>();

export const buildTaskForceToolSpec: () => AgentToolSpec | null = () => null;

export function launchTaskForceJob(options: TaskForceLaunchOptions): ReturnType<typeof launchResponseResult> {
  const { registry, carrierId, request, label, startedAt, toolName, ctx } = options;
  const requestKey = buildTaskForceRequestKey(carrierId, request);
  const backendIds = getConfiguredTaskForceBackends(carrierId);
  logDebug(
    TASKFORCE_LOG_CATEGORY_INVOKE,
    `execute start carrier=${carrierId} backends=${backendIds.length} ids=${backendIds.join(", ") || "(none)"}`,
  );

  assertRegisteredCarrier(registry, carrierId);
  const activeBackends = assertTaskForceFormable(carrierId);
  logDebug(
    TASKFORCE_LOG_CATEGORY_VALIDATE,
    `validated carrier=${carrierId} backends=${activeBackends.length} ids=${activeBackends.join(", ")}`,
  );

  // 필수 request-block 검증은 carrier_dispatch와 동일한 hard-error 타이밍을 유지합니다.
  const carrierConfig = getRegisteredCarrierConfig(registry, carrierId);
  if (carrierConfig?.carrierMetadata) {
    const blockValidation = validateTaskForceRequestBlocks(
      carrierId,
      carrierConfig.carrierMetadata,
      request,
    );
    if (blockValidation) {
      logDebug(
        TASKFORCE_LOG_CATEGORY_ERROR,
        `request-block validation failed carrier=${carrierId} missing=${blockValidation.missing.join(",")}`,
      );
      const jobId = buildCarrierJobId("taskforce", ctx.toolCallId ?? "");
      return launchResponseResult({
        job_id: jobId,
        accepted: false,
        error: blockValidation.error,
      });
    }
  }

  const launch = startDetachedJob({
    jobKind: "taskforce",
    toolName,
    toolCallId: ctx.toolCallId,
    startedAt,
    carrierIds: [carrierId],
    signal: ctx.signal,
  });
  if (!launch.accepted) return launch.response;

  const state = initTaskForceState(carrierId, requestKey, activeBackends);
  emitTaskForceJobRegistered(registry, launch.jobId, carrierId, requestKey, activeBackends, startedAt, label);

  void runTaskForceJobInBackground({
    registry,
    jobId: launch.jobId,
    carrierId,
    requestKey,
    activeBackends,
    request,
    state,
    signal: launch.signal,
    cwd: ctx.cwd,
    permit: launch.permit,
    startedAt,
    toolName,
    label,
  });

  logDebug(TASKFORCE_LOG_CATEGORY_RESULT, `carrier=${carrierId} accepted job=${launch.jobId}`);
  return launchResponseResult({ job_id: launch.jobId, accepted: true });
}

async function runTaskForceJobInBackground(opts: TaskForceBackgroundOptions): Promise<void> {
  let finalStatus: CarrierJobStatus = "done";
  let finalError: string | undefined;
  let results: TaskForceResult[] = [];
  try {
    const settledResults = await Promise.allSettled(
      opts.activeBackends.map((cliType) =>
        runTaskForceBackend(opts.registry, cliType, opts.carrierId, opts.requestKey, opts.request, opts.state, opts.signal, opts.cwd, opts.jobId),
      ),
    );
    opts.state.finishedAt = Date.now();
    results = collectTaskForceResults(settledResults, opts.activeBackends);
    finalStatus = computeTaskForceFinalStatus(results) as CarrierJobStatus;
    logDebug(
      TASKFORCE_LOG_CATEGORY_RESULT,
      `carrier=${opts.carrierId} success=${results.filter((r) => r.status === "done").length} failure=${results.filter((r) => r.status !== "done").length}`,
    );
  } catch (error) {
    finalStatus = "error";
    finalError = error instanceof Error ? error.message : String(error);
  } finally {
    const finishedAt = Date.now();
    const summary = buildTaskForceJobSummary(opts.jobId, opts.startedAt, finishedAt, opts.carrierId, results, finalStatus as StoredCarrierJobStatus, opts.toolName, finalError);
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
        kind: "taskforce",
        status: finalStatus as StoredCarrierJobStatus,
        summary,
        error: finalError,
        taskforceBackend: opts.activeBackends.join(", "),
        label: opts.label,
      }),
    });
    clearTaskForceState(opts.requestKey);
    logDebug(TASKFORCE_LOG_CATEGORY_INVOKE, `execute end carrier=${opts.carrierId} elapsedMs=${finishedAt - opts.startedAt}`);
  }
}

function formatCarrierIdForMessage(carrierId: string): string {
  return JSON.stringify(carrierId);
}

function assertRegisteredCarrier(registry: CarrierRegistry, carrierId: string): void {
  const allIds = new Set(getRegisteredOrder(registry));
  if (!allIds.has(carrierId)) {
    const registered = [...allIds].map(formatCarrierIdForMessage).join(", ") || "(none)";
    logDebug(TASKFORCE_LOG_CATEGORY_ERROR, `unknown carrier carrier=${carrierId}`);
    throw new Error(`Unknown carrier: ${formatCarrierIdForMessage(carrierId)}. Registered carriers: ${registered}`);
  }
}

function assertTaskForceFormable(carrierId: string): TaskForceCliType[] {
  const activeBackends = getConfiguredTaskForceBackends(carrierId);
  try {
    return [...assertTaskForceBackendCount(carrierId, activeBackends)] as TaskForceCliType[];
  } catch (error) {
    logDebug(TASKFORCE_LOG_CATEGORY_ERROR, `carrier=${carrierId} insufficient backends=${activeBackends.length}`);
    throw error;
  }
}

function getRequiredTaskForceModelConfig(
  carrierId: string,
  cliType: TaskForceCliType,
): NonNullable<ReturnType<typeof getTaskForceModelConfig>> {
  const modelConfig = getTaskForceModelConfig(carrierId, cliType);
  if (modelConfig) return modelConfig;
  throw new Error(`Task Force config missing for ${cliType} on carrier "${carrierId}".`);
}

async function runTaskForceBackend(
  registry: CarrierRegistry,
  cliType: TaskForceCliType,
  carrierId: string,
  requestKey: string,
  request: string,
  state: TaskForceState,
  signal: AbortSignal | undefined,
  cwd: string,
  jobId: string,
): Promise<TaskForceResult> {
  const execStartedAt = Date.now();
  const progress = state.backends.get(cliType)!;
  const syntheticId = buildTaskForceScopedRunId(requestKey, cliType);
  const modelConfig = getRequiredTaskForceModelConfig(carrierId, cliType);
  const effort = resolveValidatedEffort(cliType as CliType, modelConfig.model, modelConfig.effort);
  const trackId = `${jobId}:${cliType}`;

  logDebug(
    TASKFORCE_LOG_CATEGORY_DISPATCH,
    [
      `carrier=${carrierId} backend=${cliType} model=${modelConfig.model ?? cliType} promptChars=${request.length} run=${syntheticId}`,
      "----- BEGIN REQUEST -----",
      request,
      "----- END REQUEST -----",
    ].join("\n"),
    { hideFromFooter: true, category: "prompt" },
  );

  emitStreamEvent({
    type: "track:begin",
    jobId,
    trackId,
    requestPreview: request.trim().split(/\r?\n/, 1)[0],
  });

  try {
    const result = await executeOneShot({
      poolKey: syntheticId,
      carrierId,
      cliType: cliType as CliType,
      request,
      cwd,
      model: modelConfig.model,
      effort,
      connectSystemPrompt: buildCarrierSystemPrompt(getRegisteredCarrierConfig(registry, carrierId)?.carrierMetadata),
      signal,
      onStatusChange: (status) => {
        emitTrackStatus(jobId, trackId, status);
      },
      onMessageChunk: (text) => {
        progress.status = "streaming";
        progress.lineCount++;
        const cleanText = sanitizeChunk(text);
        appendBlock(jobId, toMessageArchiveBlock(carrierId, text, cliType));
        emitStreamEvent({ type: "track:text", jobId, trackId, text: cleanText });
      },
      onThoughtChunk: (text) => {
        const cleanText = sanitizeChunk(text);
        appendBlock(jobId, toThoughtArchiveBlock(carrierId, text, cliType));
        logDebug(TASKFORCE_LOG_CATEGORY_STREAM, `carrier=${carrierId} backend=${cliType} type=thought\n${cleanText}`, { hideFromFooter: true });
        emitStreamEvent({ type: "track:thought", jobId, trackId, text: cleanText });
      },
      onToolCall: (title, status, _rawOutput, toolCallId) => {
        progress.status = "streaming";
        progress.toolCallCount++;
        const cleanTitle = sanitizeToolLabel(title);
        const cleanStatus = sanitizeToolLabel(status);
        logDebug(TASKFORCE_LOG_CATEGORY_STREAM, `carrier=${carrierId} backend=${cliType} type=toolCall title=${cleanTitle} status=${cleanStatus}`, { hideFromFooter: true });
        emitStreamEvent({ type: "track:tool", jobId, trackId, title: cleanTitle, status: cleanStatus, toolCallId });
      },
    });

    progress.status = result.status === "done" ? "done" : "error";
    emitTrackFinalized(jobId, trackId, result);
    logDebug(
      TASKFORCE_LOG_CATEGORY_EXEC,
      `carrier=${carrierId} backend=${cliType} success=${result.status === "done"} status=${result.status} elapsedMs=${Date.now() - execStartedAt}`,
    );
    return buildTaskForceResult(cliType, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitStreamEvent({ type: "track:finalized", jobId, trackId, status: "err", error: message });
    logDebug(
      TASKFORCE_LOG_CATEGORY_EXEC,
      `carrier=${carrierId} backend=${cliType} success=false status=error elapsedMs=${Date.now() - execStartedAt}`,
    );
    throw error;
  }
}

function emitTaskForceJobRegistered(
  registry: CarrierRegistry,
  jobId: string,
  carrierId: string,
  requestKey: string,
  activeBackends: readonly TaskForceCliType[],
  startedAt: number,
  label: string,
): void {
  const tracks: TrackMeta[] = activeBackends.map((cliType) => ({
    trackId: `${jobId}:${cliType}`,
    streamKey: buildTaskForceScopedRunId(requestKey, cliType),
    displayCli: cliType,
    displayName: CLI_DISPLAY_NAMES[cliType] ?? cliType,
    subtitle: resolveCarrierDisplayName(registry, carrierId),
    kind: "backend",
  }));
  emitStreamEvent({
    type: "job:registered",
    jobId,
    kind: "taskforce",
    ownerCarrierId: carrierId,
    label,
    startedAt,
    tracks,
  });
}

function buildTaskForceResult(
  cliType: TaskForceCliType,
  result: ExecResult,
): TaskForceResult {
  return {
    cliType,
    displayName: CLI_DISPLAY_NAMES[cliType] ?? cliType,
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

function collectTaskForceResults(
  settledResults: PromiseSettledResult<TaskForceResult>[],
  activeBackends: readonly TaskForceCliType[],
): TaskForceResult[] {
  return settledResults.map((settled, index) => {
    if (settled.status === "fulfilled") return settled.value;
    return buildTaskForceErrorResult(activeBackends[index]!, settled.reason);
  });
}

function buildTaskForceErrorResult(cliType: TaskForceCliType, reason: unknown): TaskForceResult {
  const errorMessage = sanitizeChunk(reason instanceof Error ? reason.message : String(reason));
  logDebug(TASKFORCE_LOG_CATEGORY_ERROR, `backend=${cliType} message=${errorMessage}`);
  return {
    cliType,
    displayName: CLI_DISPLAY_NAMES[cliType] ?? cliType,
    status: "error",
    responseText: `Error: ${errorMessage}`,
    error: errorMessage,
  };
}

function buildTaskForceScopedRunId(requestKey: string, cliType: TaskForceCliType): string {
  const encodedRequestKey = Buffer.from(requestKey, "utf-8").toString("base64url");
  return `taskforce:${cliType}:${encodedRequestKey}`;
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

function initTaskForceState(
  carrierId: string,
  requestKey: string,
  cliTypes: readonly TaskForceCliType[],
): TaskForceState {
  const state: TaskForceState = {
    carrierId,
    requestKey,
    backends: new Map(
      cliTypes.map((cliType) => [cliType, { status: "queued", toolCallCount: 0, lineCount: 0 }]),
    ),
    startedAt: Date.now(),
  };
  taskForceStateStore.set(requestKey, state);
  return state;
}

function clearTaskForceState(requestKey: string): void {
  taskForceStateStore.delete(requestKey);
}

function logDebug(category: string, message: string, options?: unknown): void {
  getLogAPI().debug(category, message, options as LogOptions | undefined);
}
