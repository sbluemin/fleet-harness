/**
 * dispatch/taskforce.ts — Task Force 내부 실행 지원
 *
 * 선택된 Carrier의 persona를 유지한 채로 설정된 CLI 백엔드들에 동시 실행하여 교차검증합니다.
 */

import type { CliType } from "@dotobokuri/core-unified-agent";

import type { AgentToolCtx, ExecResult, OneShotExecution, OneShotReady } from "@dotobokuri/core-agent";
import type { CarrierJobStatus as StoredCarrierJobStatus } from "../jobs/types.js";
import type { JobPermitAccepted } from "../jobs/lifecycle.js";
import type { CarrierDispatchServices } from "../index.js";
import type { CarrierJobStatus, TrackMeta, TrackStatus } from "./types.js";

import {
  CLI_DISPLAY_NAMES,
} from "../constants.js";
import { appendBlock, toArchiveBlock } from "../jobs/archive.js";
import { buildCarrierResultSystemReminder } from "../jobs/dispatch.js";
import { finalizeDetachedJob, launchResponseResult, rollbackRejectedDetachedJob, startDetachedJob } from "../jobs/lifecycle.js";
import { sanitizeChunk, sanitizeProviderReason, sanitizeToolLabel } from "../jobs/sanitize.js";
import { buildCarrierJobId, buildJobSummary, computeFinalStatus } from "../jobs/types.js";
import { captureJobWindowManifest, captureWorkspaceSnapshot } from "../jobs/workspace-manifest.js";
import { executeOneShot } from "@dotobokuri/core-agent";
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
import { buildCarrierSystemPrompt, validateRequiredRequestBlocks } from "./prompt.js";
import type { CarrierToolSpecDeps } from "./prompt.js";
import {
  getConfiguredTaskForceBackends,
  getTaskForceModelConfig,
} from "../store/index.js";
import {
  claimDispatchContext,
  commitDispatchLease,
  confirmDispatchReadiness,
  releaseDispatchLease,
  type DispatchBackendSession,
  type DispatchContextBindingInput,
  type DispatchContextLease,
} from "./context-registry.js";
import {
  type BackendProgress,
  type TaskForceCliType,
  type TaskForceResult,
  type TaskForceState,
} from "./types.js";

interface PreparedTaskForceBackend {
  readonly cliType: TaskForceCliType;
  readonly trackId: string;
  readonly handle: OneShotExecution;
  readonly ready: OneShotReady;
}

interface TaskForceCompletionOptions {
  registry: CarrierRegistry;
  jobId: string;
  carrierId: string;
  originSessionId?: string;
  activeBackends: TaskForceCliType[];
  prepared: PreparedTaskForceBackend[];
  request: string;
  state: TaskForceState;
  requestKey: string;
  cwd: string;
  permit: JobPermitAccepted;
  startedAt: number;
  toolName: `carrier_${string}`;
  label: string;
  deps: CarrierToolSpecDeps;
  services?: CarrierDispatchServices;
  lease?: DispatchContextLease;
  contextId?: string;
}

interface TaskForceTrackModelInfo {
  readonly effort?: string;
  readonly model: string;
}

export interface TaskForceLaunchOptions {
  registry: CarrierRegistry;
  carrierId: string;
  request: string;
  label: string;
  startedAt: number;
  toolName: `carrier_${string}`;
  ctx: AgentToolCtx;
  /** carrier_dispatch에서 해석된 작업 디렉토리(명시 절대경로 또는 호스트 세션 cwd fallback). */
  cwd: string;
  deps: CarrierToolSpecDeps;
  /** 런타임 소유 dispatch 컨텍스트 서비스(레지스트리/추적/admission). 없으면 미추적 실행. */
  services?: CarrierDispatchServices;
  /** 이전 성공 응답의 context_id. 전달 시 동일 provider 세션 재개. */
  resumeContextId?: string;
}

const taskForceStateStore = new Map<string, TaskForceState>();

export async function launchTaskForceJob(options: TaskForceLaunchOptions): Promise<ReturnType<typeof launchResponseResult>> {
  const { registry, carrierId, request, label, startedAt, toolName, ctx, cwd, deps, services, resumeContextId } = options;
  const requestKey = buildTaskForceRequestKey(carrierId, request);

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
      return launchResponseResult({
        job_id: buildCarrierJobId("taskforce", ctx.toolCallId ?? ""),
        accepted: false,
        error: blockValidation.error,
      });
    }
  }
  let trackModelInfoByCli: ReadonlyMap<TaskForceCliType, TaskForceTrackModelInfo>;
  try {
    trackModelInfoByCli = resolveTaskForceTrackModelInfoByCli(carrierId, activeBackends);
  } catch (error) {
    return launchResponseResult({
      job_id: buildCarrierJobId("taskforce", ctx.toolCallId ?? ""),
      accepted: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 입력이 없으면 새 context_id를 발급하고, 있으면 Task Force의 backend별 provider 세션을 명시 재개한다.
  const binding: DispatchContextBindingInput = {
    carrierId,
    cwd,
    shape: "taskforce",
    backends: activeBackends.map((cliType) => ({ cliType })),
  };
  const claim = claimDispatchContext(services?.dispatchContexts, resumeContextId, binding);
  if (!claim.ok) {
    return launchResponseResult({
      job_id: buildCarrierJobId("taskforce", ctx.toolCallId ?? ""),
      accepted: false,
      error: claim.error,
    });
  }

  const launch = startDetachedJob({
    jobKind: "taskforce",
    toolName,
    toolCallId: ctx.toolCallId,
    startedAt,
    carrierIds: [carrierId],
    signal: ctx.signal,
  });
  if (!launch.accepted) {
    releaseDispatchLease(services?.dispatchContexts, claim.lease);
    return launch.response;
  }

  const state = initTaskForceState(carrierId, requestKey, activeBackends);

  // 백엔드마다 fresh one-shot 핸들을 만들고, resume 세션은 백엔드별로 분리해 주입한다.
  const handles = activeBackends.map((cliType) => {
    const modelInfo = trackModelInfoByCli.get(cliType);
    if (!modelInfo) throw new Error(`Task Force config missing for ${cliType} on carrier "${carrierId}".`);
    const trackId = `${launch.jobId}:${cliType}`;
    const progress = state.backends.get(cliType)!;
    const handle = executeOneShot({
      scopeId: carrierId,
      authEnvResolver: deps.authEnvResolver,
      reservedExternalMcpServerIds: deps.reservedExternalMcpServerIds,
      cliType: cliType as CliType,
      request,
      cwd,
      model: modelInfo.model,
      effort: modelInfo.effort,
      resumeSessionId: claim.resumeSessions?.get(cliType),
      connectSystemPrompt: buildCarrierSystemPrompt(carrierConfig?.carrierMetadata),
      signal: launch.signal,
      ...buildTaskForceBackendListeners(registry, launch.jobId, ctx.sessionLabel, carrierId, cliType, trackId, progress),
    });
    return { cliType, trackId, handle };
  });

  // 전-백엔드 readiness 배리어 — 하나라도 실패하면 프롬프트를 0건 전송하고 준비된 모든 핸들을 정리한다.
  const readinessResults = await Promise.allSettled(handles.map((h) => h.handle.readiness));
  const failure = readinessResults.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure) {
    await Promise.allSettled(handles.map((h) => h.handle.abort()));
    await rollbackRejectedDetachedJob({ jobId: launch.jobId, permit: launch.permit });
    releaseDispatchLease(services?.dispatchContexts, claim.lease);
    clearTaskForceState(requestKey);
    const message = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
    return launchResponseResult({ job_id: launch.jobId, accepted: false, error: sanitizeProviderReason(message) });
  }

  const prepared: PreparedTaskForceBackend[] = handles.map((h, index) => ({
    cliType: h.cliType,
    trackId: h.trackId,
    handle: h.handle,
    ready: (readinessResults[index] as PromiseFulfilledResult<OneShotReady>).value,
  }));
  confirmDispatchReadiness(services?.dispatchContexts, claim.lease, prepared.map((p) => readyToSession(p.ready)));

  emitTaskForceJobRegistered(registry, launch.jobId, carrierId, ctx.sessionLabel, requestKey, activeBackends, startedAt, label, trackModelInfoByCli);

  const execStartedAt = Date.now();
  for (const backend of prepared) {
    emitStreamEvent(registry, {
      type: "track:begin",
      jobId: launch.jobId,
      originSessionId: ctx.sessionLabel,
      trackId: backend.trackId,
      startedAt: execStartedAt,
      requestPreview: request.trim().split(/\r?\n/, 1)[0],
    });
    backend.handle.startPrompt();
  }

  const completion = runTaskForceCompletion({
    registry,
    jobId: launch.jobId,
    carrierId,
    originSessionId: ctx.sessionLabel,
    activeBackends,
    prepared,
    request,
    state,
    requestKey,
    cwd,
    permit: launch.permit,
    startedAt,
    toolName,
    label,
    deps,
    services,
    lease: claim.lease,
    contextId: claim.contextId,
  });
  const untrack = services?.trackInFlight?.({
    cancel: async () => { await Promise.allSettled(prepared.map((p) => p.handle.abort())); },
    completion,
  }) ?? (() => {});
  void completion.finally(untrack);

  return launchResponseResult({
    job_id: launch.jobId,
    ...(claim.contextId ? { context_id: claim.contextId } : {}),
    accepted: true,
  });
}

function readyToSession(ready: OneShotReady): DispatchBackendSession {
  return { cliType: ready.cliType, protocol: ready.protocol, sessionId: ready.sessionId };
}

/**
 * Drive every Task Force backend one-shot handle to completion after the shared prompt gate opens.
 * Commits the dispatch mapping only when every backend turn is `done` (atomic all-backend commit);
 * any other outcome unlocks the lease without committing.
 */
async function runTaskForceCompletion(opts: TaskForceCompletionOptions): Promise<void> {
  let finalStatus: CarrierJobStatus = "done";
  let finalError: string | undefined;
  let results: TaskForceResult[] = [];
  const baselineSnapshot = await captureWorkspaceSnapshot(opts.deps.workspaceChangeScanner, opts.cwd);
  try {
    const settledResults = await Promise.allSettled(
      opts.prepared.map((backend) =>
        finalizeTaskForceBackend(opts.registry, backend, opts.jobId, opts.originSessionId, opts.state),
      ),
    );
    opts.state.finishedAt = Date.now();
    results = collectTaskForceResults(settledResults, opts.activeBackends);
    finalStatus = computeFinalStatus(results) as CarrierJobStatus;
    if (finalStatus === "done") {
      commitDispatchLease(opts.services?.dispatchContexts, opts.lease, opts.prepared.map((p) => readyToSession(p.ready)));
    } else {
      releaseDispatchLease(opts.services?.dispatchContexts, opts.lease);
    }
  } catch (error) {
    finalStatus = "error";
    finalError = error instanceof Error ? error.message : String(error);
    releaseDispatchLease(opts.services?.dispatchContexts, opts.lease);
  } finally {
    const finishedAt = Date.now();
    const workspaceChanges = await captureJobWindowManifest(opts.deps.workspaceChangeScanner, opts.cwd, baselineSnapshot);
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
      workspaceChanges,
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
      originSessionId: opts.originSessionId,
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
        contextId: opts.contextId,
        resumeAvailable: finalStatus === "done",
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
  return [...assertTaskForceBackendCount(carrierId, activeBackends)] as TaskForceCliType[];
}

function getRequiredTaskForceModelConfig(
  carrierId: string,
  cliType: TaskForceCliType,
): NonNullable<ReturnType<typeof getTaskForceModelConfig>> {
  const modelConfig = getTaskForceModelConfig(carrierId, cliType);
  if (modelConfig) return modelConfig;
  throw new Error(`Task Force config missing for ${cliType} on carrier "${carrierId}".`);
}

/** Streaming listeners for one Task Force backend one-shot handle. */
function buildTaskForceBackendListeners(
  registry: CarrierRegistry,
  jobId: string,
  originSessionId: string | undefined,
  carrierId: string,
  cliType: TaskForceCliType,
  trackId: string,
  progress: BackendProgress,
) {
  return {
    onStatusChange: (status: TrackStatus) => {
      emitTrackStatus(registry, jobId, originSessionId, trackId, status);
    },
    onMessageChunk: (text: string) => {
      progress.status = "streaming";
      progress.lineCount++;
      const cleanText = sanitizeChunk(text);
      appendBlock(jobId, toArchiveBlock("text", carrierId, text, cliType));
      emitStreamEvent(registry, { type: "track:text", jobId, originSessionId, trackId, text: cleanText });
    },
    onThoughtChunk: (text: string) => {
      const cleanText = sanitizeChunk(text);
      appendBlock(jobId, toArchiveBlock("thought", carrierId, text, cliType));
      emitStreamEvent(registry, { type: "track:thought", jobId, originSessionId, trackId, text: cleanText });
    },
    onToolCall: (title: string, status: string, rawOutput?: string, toolCallId?: string) => {
      progress.status = "streaming";
      progress.toolCallCount++;
      const cleanTitle = sanitizeToolLabel(title);
      const cleanStatus = sanitizeToolLabel(status);
      emitStreamEvent(registry, {
        type: "track:tool",
        jobId,
        originSessionId,
        trackId,
        detailChars: rawOutput?.length ?? 0,
        title: cleanTitle,
        status: cleanStatus,
        toolCallId,
      });
    },
  };
}

async function finalizeTaskForceBackend(
  registry: CarrierRegistry,
  backend: PreparedTaskForceBackend,
  jobId: string,
  originSessionId: string | undefined,
  state: TaskForceState,
): Promise<TaskForceResult> {
  const result = await backend.handle.completion;
  const progress = state.backends.get(backend.cliType);
  if (progress) progress.status = result.status === "done" ? "done" : "error";
  emitTrackFinalized(registry, jobId, originSessionId, backend.trackId, result, backend.ready.sessionId);
  return buildTaskForceResult(backend.cliType, result);
}

function emitTaskForceJobRegistered(
  registry: CarrierRegistry,
  jobId: string,
  carrierId: string,
  originSessionId: string | undefined,
  requestKey: string,
  activeBackends: readonly TaskForceCliType[],
  startedAt: number,
  label: string,
  trackModelInfoByCli: ReadonlyMap<TaskForceCliType, TaskForceTrackModelInfo>,
): void {
  const tracks: TrackMeta[] = activeBackends.map((cliType) => {
    const modelInfo = trackModelInfoByCli.get(cliType);
    if (!modelInfo) throw new Error(`Task Force config missing for ${cliType} on carrier "${carrierId}".`);
    return {
      trackId: `${jobId}:${cliType}`,
      streamKey: buildTaskForceScopedRunId(requestKey, cliType),
      displayCli: cliType,
      displayName: CLI_DISPLAY_NAMES[cliType] ?? cliType,
      effort: modelInfo.effort,
      model: modelInfo.model,
      subtitle: resolveCarrierDisplayName(registry, carrierId),
      kind: "backend",
    };
  });
  emitStreamEvent(registry, {
    type: "job:registered",
    jobId,
    originSessionId,
    kind: "taskforce",
    ownerCarrierId: carrierId,
    label,
    startedAt,
    tracks,
  });
}

function resolveTaskForceTrackModelInfoByCli(
  carrierId: string,
  activeBackends: readonly TaskForceCliType[],
): ReadonlyMap<TaskForceCliType, TaskForceTrackModelInfo> {
  return new Map(activeBackends.map((cliType) => [cliType, resolveTaskForceTrackModelInfo(carrierId, cliType)]));
}

function resolveTaskForceTrackModelInfo(carrierId: string, cliType: TaskForceCliType): TaskForceTrackModelInfo {
  const modelConfig = getRequiredTaskForceModelConfig(carrierId, cliType);
  return {
    model: modelConfig.model,
    effort: resolveValidatedEffort(cliType as CliType, modelConfig.model, modelConfig.effort),
  };
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

function emitTrackStatus(registry: CarrierRegistry, jobId: string, originSessionId: string | undefined, trackId: string, status: TrackStatus): void {
  emitStreamEvent(registry, { type: "track:status", jobId, originSessionId, trackId, status });
}

function emitTrackFinalized(registry: CarrierRegistry, jobId: string, originSessionId: string | undefined, trackId: string, result: ExecResult, sessionId?: string): void {
  const status = toCarrierJobStatus(result.status);
  emitStreamEvent(registry, {
    type: "track:finalized",
    jobId,
    originSessionId,
    trackId,
    status: toTrackFinalStatus(status),
    finishedAt: Date.now(),
    error: status === "aborted" ? "aborted" : result.error,
    sessionId: result.sessionId ?? sessionId,
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
