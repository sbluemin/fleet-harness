/**
 * taskforce/tool-spec.ts — Task Force 내부 실행 지원
 *
 * 선택된 Carrier의 persona를 유지한 채로 설정된 CLI 백엔드들에 동시 실행하여 교차검증합니다.
 */

import { getEffort, type CliType } from "@dotobokuri/fleet-unified-agent";

import type { AgentToolCtx } from "@dotobokuri/fleet-mcp-server";
import type { CarrierJobStatus as StoredCarrierJobStatus, CarrierJobSummary } from "../jobs/types.js";
import type { JobPermitAccepted } from "../jobs/lifecycle.js";
import type { LogOptions } from "@dotobokuri/fleet-infra/log";
import type { ExecResult } from "@dotobokuri/fleet-infra/agent";
import type { CarrierJobStatus, ModelEffort, TrackMeta, TrackStatus } from "./types.js";

import {
  CLI_DISPLAY_NAMES,
} from "../constants.js";
import { appendBlock, toMessageArchiveBlock, toThoughtArchiveBlock } from "../jobs/archive.js";
import { buildCarrierResultSystemReminder } from "../jobs/dispatch.js";
import { finalizeDetachedJob, launchResponseResult, startDetachedJob } from "../jobs/lifecycle.js";
import { sanitizeChunk, sanitizeToolLabel } from "../jobs/sanitize.js";
import { buildCarrierJobId } from "../jobs/types.js";
import { getLogAPI } from "@dotobokuri/fleet-infra/log";
import { executeWithPool } from "@dotobokuri/fleet-infra/agent";
import {
  emitStreamEvent,
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  resolveCarrierDisplayName,
  type CarrierRegistry,
} from "./framework.js";
import { buildCarrierSystemPrompt, validateRequiredRequestBlocks } from "./tool-spec.js";
import {
  getConfiguredTaskForceBackends,
  getTaskForceModelConfig,
} from "../store/index.js";
import {
  type CarrierMetadata,
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
    emitStreamEvent(opts.registry, {
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
  const poolKey = buildTaskForceRunId(carrierId, cliType);
  const streamKey = buildTaskForceScopedRunId(requestKey, cliType);
  const modelConfig = getRequiredTaskForceModelConfig(carrierId, cliType);
  const effort = resolveValidatedEffort(cliType as CliType, modelConfig.model, modelConfig.effort);
  const trackId = `${jobId}:${cliType}`;

  logDebug(
    TASKFORCE_LOG_CATEGORY_DISPATCH,
    [
      `carrier=${carrierId} backend=${cliType} model=${modelConfig.model ?? cliType} promptChars=${request.length} pool=${poolKey} stream=${streamKey}`,
      "----- BEGIN REQUEST -----",
      request,
      "----- END REQUEST -----",
    ].join("\n"),
    { hideFromFooter: true, category: "prompt" },
  );

  emitStreamEvent(registry, {
    type: "track:begin",
    jobId,
    trackId,
    requestPreview: request.trim().split(/\r?\n/, 1)[0],
  });

  try {
    const result = await executeWithPool({
      poolKey,
      carrierId,
      cliType: cliType as CliType,
      request,
      cwd,
      model: modelConfig.model,
      effort,
      connectSystemPrompt: buildCarrierSystemPrompt(getRegisteredCarrierConfig(registry, carrierId)?.carrierMetadata),
      signal,
      onStatusChange: (status) => {
        emitTrackStatus(registry, jobId, trackId, status);
      },
      onMessageChunk: (text) => {
        progress.status = "streaming";
        progress.lineCount++;
        const cleanText = sanitizeChunk(text);
        appendBlock(jobId, toMessageArchiveBlock(carrierId, text, cliType));
        emitStreamEvent(registry, { type: "track:text", jobId, trackId, text: cleanText });
      },
      onThoughtChunk: (text) => {
        const cleanText = sanitizeChunk(text);
        appendBlock(jobId, toThoughtArchiveBlock(carrierId, text, cliType));
        logDebug(TASKFORCE_LOG_CATEGORY_STREAM, `carrier=${carrierId} backend=${cliType} type=thought\n${cleanText}`, { hideFromFooter: true });
        emitStreamEvent(registry, { type: "track:thought", jobId, trackId, text: cleanText });
      },
      onToolCall: (title, status, _rawOutput, toolCallId) => {
        progress.status = "streaming";
        progress.toolCallCount++;
        const cleanTitle = sanitizeToolLabel(title);
        const cleanStatus = sanitizeToolLabel(status);
        logDebug(TASKFORCE_LOG_CATEGORY_STREAM, `carrier=${carrierId} backend=${cliType} type=toolCall title=${cleanTitle} status=${cleanStatus}`, { hideFromFooter: true });
        emitStreamEvent(registry, { type: "track:tool", jobId, trackId, title: cleanTitle, status: cleanStatus, toolCallId });
      },
    });

    progress.status = result.status === "done" ? "done" : "error";
    emitTrackFinalized(registry, jobId, trackId, result);
    logDebug(
      TASKFORCE_LOG_CATEGORY_EXEC,
      `carrier=${carrierId} backend=${cliType} success=${result.status === "done"} status=${result.status} elapsedMs=${Date.now() - execStartedAt}`,
    );
    return buildTaskForceResult(cliType, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitStreamEvent(registry, { type: "track:finalized", jobId, trackId, status: "err", error: message });
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
  emitStreamEvent(registry, {
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

export function buildTaskForceErrorResult(cliType: TaskForceCliType, reason: unknown): TaskForceResult {
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

function emitTrackStatus(registry: CarrierRegistry, jobId: string, trackId: string, status: TrackStatus): void {
  emitStreamEvent(registry, { type: "track:status", jobId, trackId, status });
}

function emitTrackFinalized(registry: CarrierRegistry, jobId: string, trackId: string, result: ExecResult): void {
  const status = toCarrierJobStatus(result.status);
  emitStreamEvent(registry, {
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

export function assertTaskForceBackendCount(carrierId: string, backends: readonly TaskForceCliType[]): readonly TaskForceCliType[] {
  if (backends.length >= 2) return backends;
  throw new Error(
    `Carrier ${formatCarrierIdForMessage(carrierId)} needs ≥2 configured Task Force backends, got ${backends.length}. ` +
    `Open Carrier Status (Alt+O), select ${formatCarrierIdForMessage(carrierId)}, press T to add a backend.`,
  );
}

export function buildTaskForceRequestKey(carrierId: string, request: string): string {
  return JSON.stringify([carrierId, request.replace(/\r\n?/g, "\n").trim()]);
}

export function buildTaskForceRunId(carrierId: string, cliType: TaskForceCliType): string {
  const encodedCarrierId = Buffer.from(carrierId, "utf-8").toString("base64url");
  return `taskforce:${cliType}:${encodedCarrierId}`;
}

export function computeTaskForceFinalStatus(results: readonly TaskForceResult[]): StoredCarrierJobStatus {
  if (results.some((result) => result.status === "aborted")) return "aborted";
  if (results.some((result) => result.status === "error")) return "error";
  return "done";
}

export function buildTaskForceSummaryText(
  status: StoredCarrierJobStatus,
  successCount: number,
  failureCount: number,
  error?: string,
): string {
  if (status === "aborted") return `carrier_dispatch taskforce aborted: ${successCount} done, ${failureCount} failed`;
  if (error) return `carrier_dispatch taskforce failed: ${error}`;
  return `carrier_dispatch taskforce completed: ${successCount} done, ${failureCount} failed`;
}

export function buildTaskForceJobSummary(
  jobId: string,
  startedAt: number,
  finishedAt: number,
  carrierId: string,
  results: readonly TaskForceResult[],
  status: StoredCarrierJobStatus,
  toolName: `carrier_${string}`,
  error?: string,
): CarrierJobSummary {
  const successCount = results.filter((result) => result.status === "done").length;
  const failureCount = results.length - successCount;
  return {
    jobId,
    tool: toolName,
    status,
    summary: buildTaskForceSummaryText(status, successCount, failureCount, error),
    startedAt,
    finishedAt,
    carriers: [carrierId],
    error,
  };
}

export function sanitizeTaskForceChunk(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\x1b\[\d*[ABCDEFGHJKST]/g, "")
    .replace(/\x1b\[\d*;\d*[Hf]/g, "")
    .replace(/\x1b\[(?:\??\d+[hl]|2J|K)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function sanitizeTaskForceToolLabel(text: string): string {
  return sanitizeTaskForceChunk(text).replace(/\s+/g, " ").trim() || "(unnamed)";
}

/**
 * taskforce request에 대해 필수 request-block 검증을 수행합니다.
 *
 * @returns 검증 실패 결과, 통과하면 null
 */
export function validateTaskForceRequestBlocks(
  carrierId: string,
  meta: CarrierMetadata,
  request: string,
): { error: string; missing: string[] } | null {
  const result = validateRequiredRequestBlocks(meta, request, carrierId);
  if (!result.ok) return { error: result.error, missing: result.missing };
  return null;
}
