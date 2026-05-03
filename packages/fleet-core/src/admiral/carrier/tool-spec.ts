/**
 * carrier/tool-spec.ts — 개별 캐리어 도구 스펙
 *
 * 등록된 모든 캐리어에 대해 개별 AgentToolSpec(carrier_<id>)을 생성합니다.
 * offline/squadron 상태는 도구 등록 여부에 영향을 주지 않으며,
 * 런타임 컨텍스트 태그(`<offline_carriers>`, `<available_squadron_carriers>`)로 모델에 안내됩니다.
 * offline 호출만 execute() 진입점에서 안전장치로 거부합니다.
 */

import type { CliType } from "@sbluemin/unified-agent";

import type { AgentToolSpec } from "../../infra/tool-registry/index.js";
import type { CarrierJobStatus as StoredCarrierJobStatus, JobPermitAccepted } from "../../infra/job/index.js";
import type { LogOptions } from "../../infra/log/index.js";

import { ANSI_RESET, SORTIE_SUMMARY_COLOR } from "../../constants.js";
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
} from "../../infra/job/index.js";
import { getLogAPI } from "../../infra/log/store.js";
import { registerToolPromptManifest } from "../../infra/tool-registry/index.js";
import {
  emitStreamEvent,
  type CarrierJobStatus,
  type TrackMeta,
  type TrackStatus,
} from "../_shared/carrier-job-events.js";
import { executeWithPool } from "../agent/executor.js";
import {
  buildCarrierSystemPrompt,
  buildCarrierToolManifest,
  buildCarrierToolSchema,
  composeTier2Request,
} from "./prompts.js";
import {
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  isCarrierOnline,
  resolveCarrierDisplayName,
} from "./framework.js";
import { validateRequiredRequestBlocks } from "./request-blocks.js";
import {
  buildSortieJobSummary,
  computeSortieFinalStatus,
} from "./sortie-execute.js";

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
  jobId: string;
  carrierId: string;
  request: string;
  signal: AbortSignal | undefined;
  cwd: string;
  permit: JobPermitAccepted;
  startedAt: number;
  toolName: `carrier_${string}`;
}

const CARRIER_LOG_CATEGORY_INVOKE = "fleet-carrier:invoke";
const CARRIER_LOG_CATEGORY_DISPATCH = "fleet-carrier:dispatch";
const CARRIER_LOG_CATEGORY_STREAM = "fleet-carrier:stream";
const CARRIER_LOG_CATEGORY_EXEC = "fleet-carrier:exec";
const CARRIER_LOG_CATEGORY_RESULT = "fleet-carrier:result";
const CARRIER_LOG_CATEGORY_ERROR = "fleet-carrier:error";

/**
 * 등록된 모든 캐리어에 대해 개별 AgentToolSpec을 생성합니다.
 * offline/squadron 상태와 무관하게 등록된 캐리어는 모두 도구로 노출됩니다.
 */
export function buildCarrierToolSpecs(): AgentToolSpec[] {
  const carrierIds = getRegisteredOrder();
  if (carrierIds.length < 1) return [];

  const specs: AgentToolSpec[] = [];

  for (const carrierId of carrierIds) {
    const config = getRegisteredCarrierConfig(carrierId);
    if (!config) continue;

    const displayName = config.displayName;
    const metadata = config.carrierMetadata;

    // 메타데이터가 없는 캐리어는 스펙을 생성하지 않음
    if (!metadata) continue;

    const manifest = buildCarrierToolManifest(carrierId, displayName, metadata);
    registerToolPromptManifest(manifest);

    specs.push(buildSingleCarrierSpec(carrierId, displayName, metadata, manifest));
  }

  return specs;
}

function buildSingleCarrierSpec(
  carrierId: string,
  displayName: string,
  metadata: import("./types.js").CarrierMetadata,
  manifest: import("../../infra/tool-registry/types.js").ToolPromptManifest,
): AgentToolSpec {
  const toolName: `carrier_${string}` = `carrier_${carrierId}`;

  return {
    name: toolName,
    label: `${displayName} Carrier`,
    description: manifest.description,
    promptSnippet: manifest.promptSnippet,
    promptGuidelines: [
      ...manifest.whenToUse,
      ...manifest.whenNotToUse,
      ...manifest.usageGuidelines,
      ...(manifest.guardrails ?? []),
    ],
    parameters: buildCarrierToolSchema(),

    render: {
      call() {
        return `${SORTIE_SUMMARY_COLOR}${carrierId}${ANSI_RESET}`;
      },
    },

    async execute(args: unknown, ctx) {
      const t0 = Date.now();
      const cwd = ctx.cwd;
      const params = args as { request: string };
      const request = params.request;
      const toolCallId = ctx.toolCallId ?? "";
      const jobId = buildCarrierJobId("carrier", toolCallId);

      logDebug(
        CARRIER_LOG_CATEGORY_INVOKE,
        `execute start carrier=${carrierId}`,
      );

      // 캐리어 online 상태 확인
      if (!isCarrierOnline(carrierId)) {
        logDebug(CARRIER_LOG_CATEGORY_ERROR, `carrier offline carrier=${carrierId}`);
        return launchResponseResult({
          job_id: jobId,
          accepted: false,
          error: `Carrier "${carrierId}" is offline.`,
        });
      }

      // 필수 request-block 검증
      const blockValidation = validateRequiredRequestBlocks(metadata, request, carrierId);
      if (!blockValidation.ok) {
        logDebug(CARRIER_LOG_CATEGORY_ERROR, `request-block validation failed carrier=${carrierId}`);
        return launchResponseResult({
          job_id: jobId,
          accepted: false,
          error: blockValidation.error,
        });
      }

      // Tier 2 request 조립
      const composedRequest = composeTier2Request(metadata, request);

      const launch = startDetachedJob({
        jobKind: "carrier",
        toolName,
        toolCallId,
        startedAt: t0,
        carrierIds: [carrierId],
        signal: ctx.signal,
      });
      if (!launch.accepted) return launch.response;

      emitJobRegistered(jobId, carrierId, toolCallId, t0);

      void runCarrierJobInBackground({
        jobId,
        carrierId,
        request: composedRequest,
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
      : [{ carrierId: opts.carrierId, displayName: resolveCarrierDisplayName(opts.carrierId), status: "error" as CarrierJobStatus, responseText: finalError ?? "Unknown error", error: finalError }];
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
        label: resolveCarrierDisplayName(opts.carrierId),
      }),
    });
    logDebug(CARRIER_LOG_CATEGORY_INVOKE, `execute end carrier=${opts.carrierId} elapsedMs=${finishedAt - opts.startedAt}`);
  }
}

async function runSingleCarrier(opts: CarrierBackgroundOptions): Promise<CarrierSingleResult> {
  const execStartedAt = Date.now();
  const carrierConfig = getRegisteredCarrierConfig(opts.carrierId);
  const cliType = (carrierConfig?.cliType ?? opts.carrierId) as CliType;
  let sessionId: string | undefined;

  logDebug(
    CARRIER_LOG_CATEGORY_DISPATCH,
    [
      `carrier=${opts.carrierId} model=${cliType} promptChars=${opts.request.length}`,
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
      cliType,
      carrierId: opts.carrierId,
      request: opts.request,
      cwd: opts.cwd,
      connectSystemPrompt: buildCarrierSystemPrompt(),
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
      displayName: resolveCarrierDisplayName(opts.carrierId),
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
  jobId: string,
  carrierId: string,
  sortieKey: string,
  startedAt: number,
): void {
  const tracks: TrackMeta[] = [{
    trackId: carrierId,
    streamKey: carrierId,
    displayCli: carrierId,
    displayName: resolveCarrierDisplayName(carrierId),
    kind: "carrier",
  }];
  emitStreamEvent({
    type: "job:registered",
    jobId,
    kind: "carrier",
    ownerCarrierId: carrierId,
    label: resolveCarrierDisplayName(carrierId),
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

function logDebug(category: string, message: string, options?: unknown): void {
  getLogAPI().debug(category, message, options as LogOptions | undefined);
}
