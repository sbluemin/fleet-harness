/**
 * taskforce/tool-spec.ts — Task Force 내부 실행 지원
 *
 * 선택된 Carrier의 persona를 유지한 채로 설정된 CLI 백엔드들에 동시 실행하여 교차검증합니다.
 */

import type { CliType } from "@dotobokuri/fleet-unified-agent";

import type { AgentToolCtx } from "@dotobokuri/fleet-mcp-server";
import type { CarrierJobStatus as StoredCarrierJobStatus } from "../jobs/types.js";
import type { JobPermitAccepted } from "../jobs/lifecycle.js";
import type { ExecResult } from "@dotobokuri/fleet-infra/agent";
import type { CarrierJobStatus, TrackMeta, TrackStatus } from "./types.js";

import {
  CLI_DISPLAY_NAMES,
} from "../constants.js";
import { appendBlock, toArchiveBlock } from "../jobs/archive.js";
import { buildCarrierResultSystemReminder } from "../jobs/dispatch.js";
import { finalizeDetachedJob, launchResponseResult, startDetachedJob } from "../jobs/lifecycle.js";
import { sanitizeChunk, sanitizeToolLabel } from "../jobs/sanitize.js";
import { buildCarrierJobId, buildJobSummary, computeFinalStatus } from "../jobs/types.js";
import { executeWithPool } from "@dotobokuri/fleet-infra/agent";
import {
  emitStreamEvent,
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  resolveCarrierDisplayName,
  resolveValidatedEffort,
  toCarrierJobStatus,
  toTrackFinalStatus,
  type CarrierRegistry,
} from "./framework.js";
import { buildCarrierSystemPrompt, validateRequiredRequestBlocks } from "./tool-spec.js";
import {
  getConfiguredTaskForceBackends,
  getTaskForceModelConfig,
} from "../store/index.js";
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

const taskForceStateStore = new Map<string, TaskForceState>();

export function launchTaskForceJob(options: TaskForceLaunchOptions): ReturnType<typeof launchResponseResult> {
  const { registry, carrierId, request, label, startedAt, toolName, ctx } = options;
  const requestKey = buildTaskForceRequestKey(carrierId, request);
  const backendIds = getConfiguredTaskForceBackends(carrierId);

  assertRegisteredCarrier(registry, carrierId);
  const activeBackends = assertTaskForceFormable(carrierId);

  // 필수 request-block 검증은 carrier_dispatch와 동일한 hard-error 타이밍을 유지합니다.
  const carrierConfig = getRegisteredCarrierConfig(registry, carrierId);
  if (carrierConfig?.carrierMetadata) {
    const blockValidation = validateRequiredRequestBlocks(
      carrierConfig.carrierMetadata,
      request,
      carrierId,
    );
    if (!blockValidation.ok) {
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
    finalStatus = computeFinalStatus(results) as CarrierJobStatus;
  } catch (error) {
    finalStatus = "error";
    finalError = error instanceof Error ? error.message : String(error);
  } finally {
    const finishedAt = Date.now();
    const summary = buildJobSummary({
      jobId: opts.jobId,
      startedAt: opts.startedAt,
      finishedAt,
      carriers: [opts.carrierId],
      results,
      status: finalStatus as StoredCarrierJobStatus,
      error: finalError,
      tool: opts.toolName,
      prefix: "carrier_dispatch taskforce",
    });
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
  }
}

function formatCarrierIdForMessage(carrierId: string): string {
  return JSON.stringify(carrierId);
}

function assertRegisteredCarrier(registry: CarrierRegistry, carrierId: string): void {
  const allIds = new Set(getRegisteredOrder(registry));
  if (!allIds.has(carrierId)) {
    const registered = [...allIds].map(formatCarrierIdForMessage).join(", ") || "(none)";
    throw new Error(`Unknown carrier: ${formatCarrierIdForMessage(carrierId)}. Registered carriers: ${registered}`);
  }
}

function assertTaskForceFormable(carrierId: string): TaskForceCliType[] {
  const activeBackends = getConfiguredTaskForceBackends(carrierId);
  try {
    return [...assertTaskForceBackendCount(carrierId, activeBackends)] as TaskForceCliType[];
  } catch (error) {
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
        appendBlock(jobId, toArchiveBlock("text", carrierId, text, cliType));
        emitStreamEvent(registry, { type: "track:text", jobId, trackId, text: cleanText });
      },
      onThoughtChunk: (text) => {
        const cleanText = sanitizeChunk(text);
        appendBlock(jobId, toArchiveBlock("thought", carrierId, text, cliType));
        emitStreamEvent(registry, { type: "track:thought", jobId, trackId, text: cleanText });
      },
      onToolCall: (title, status, _rawOutput, toolCallId) => {
        progress.status = "streaming";
        progress.toolCallCount++;
        const cleanTitle = sanitizeToolLabel(title);
        const cleanStatus = sanitizeToolLabel(status);
        emitStreamEvent(registry, { type: "track:tool", jobId, trackId, title: cleanTitle, status: cleanStatus, toolCallId });
      },
    });

    progress.status = result.status === "done" ? "done" : "error";
    emitTrackFinalized(registry, jobId, trackId, result);
    return buildTaskForceResult(cliType, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitStreamEvent(registry, { type: "track:finalized", jobId, trackId, status: "err", error: message });
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

export { buildJobSummary as buildTaskForceJobSummary, computeFinalStatus as computeTaskForceFinalStatus };
