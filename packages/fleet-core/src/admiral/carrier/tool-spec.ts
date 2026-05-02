/**
 * carrier/tool-spec.ts — Carrier Sortie 도구 스펙
 *
 * carrier 위임의 host-agnostic Fleet 도구 스펙입니다.
 * 1개 이상 Carrier에 작업을 위임(출격)할 때 사용합니다.
 */

import type { CliType } from "@sbluemin/unified-agent";

import type { AgentToolSpec } from "../../services/tool-registry/index.js";
import type { CarrierJobStatus as StoredCarrierJobStatus, JobPermitAccepted } from "../../services/job/index.js";
import type { LogOptions } from "../../services/log/index.js";
import type { CarrierSortieOutcome } from "./sortie-execute.js";

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
} from "../../services/job/index.js";
import { getLogAPI } from "../../services/log/store.js";
import { registerToolPromptManifest } from "../../services/tool-registry/index.js";
import {
  emitStreamEvent,
  type CarrierJobStatus,
  type TrackMeta,
  type TrackStatus,
} from "../_shared/carrier-job-events.js";
import { executeWithPool, type AgentStatus } from "../_shared/agent-runtime.js";
import {
  buildCarrierSystemPrompt,
  FLEET_SORTIE_DESCRIPTION,
  SORTIE_MANIFEST,
  buildSortieToolPromptSnippet,
  buildSortieToolPromptGuidelines,
  buildSortieToolSchema,
  composeTier2Request,
  type CarrierAssignment,
} from "./prompts.js";
import {
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  getSortieEnabledIds,
  isSortieCarrierEnabled,
  isSquadronCarrierEnabled,
  resolveCarrierDisplayName,
} from "./framework.js";
import {
  buildSortieJobSummary,
  computeSortieFinalStatus,
  validateSortieAssignments,
} from "./sortie-execute.js";

interface CarrierSortieResult extends CarrierSortieOutcome {
  carrierId: string;
  displayName: string;
  status: CarrierJobStatus;
  responseText: string;
  sessionId?: string;
  error?: string;
  thinking?: string;
  toolCalls?: { title: string; status: string }[];
}

interface SortieBackgroundOptions {
  jobId: string;
  sortieKey: string;
  assignments: CarrierAssignment[];
  state: SortieState;
  signal: AbortSignal | undefined;
  cwd: string;
  permit: JobPermitAccepted;
  startedAt: number;
}

interface CarrierProgress {
  status: "queued" | "connecting" | "streaming" | "done" | "error";
  toolCallCount: number;
  lineCount: number;
}

interface SortieState {
  sortieKey: string;
  carriers: Map<string, CarrierProgress>;
  startedAt: number;
  finishedAt?: number;
}

const SORTIE_LOG_CATEGORY_INVOKE = "fleet-sortie:invoke";
const SORTIE_LOG_CATEGORY_VALIDATE = "fleet-sortie:validate";
const SORTIE_LOG_CATEGORY_DISPATCH = "fleet-sortie:dispatch";
const SORTIE_LOG_CATEGORY_STREAM = "fleet-sortie:stream";
const SORTIE_LOG_CATEGORY_EXEC = "fleet-sortie:exec";
const SORTIE_LOG_CATEGORY_RESULT = "fleet-sortie:result";
const SORTIE_LOG_CATEGORY_ERROR = "fleet-sortie:error";
const sortieStateStore = new Map<string, SortieState>();

export function buildSortieToolSpec(): AgentToolSpec | null {
  const allCarriers = getRegisteredOrder();
  if (allCarriers.length < 1) return null;

  registerToolPromptManifest(SORTIE_MANIFEST);

  const enabledIds = getSortieEnabledIds();
  const mergedGuidelines = buildSortieToolPromptGuidelines(enabledIds);

  return {
    name: "carriers_sortie",
    label: "Carriers Sortie",
    description: FLEET_SORTIE_DESCRIPTION,
    promptSnippet: buildSortieToolPromptSnippet(),
    promptGuidelines: mergedGuidelines,
    parameters: buildSortieToolSchema(enabledIds),

    render: {
      call(args: unknown) {
        const typedArgs = args as { carriers?: CarrierAssignment[] };
        return formatSortieRenderPayload(typedArgs.carriers ?? []);
      },
    },

    async execute(args: unknown, ctx) {
      const t0 = ctx.now();
      const cwd = ctx.cwd;
      const params = args as { expected_carrier_count: number; carriers: CarrierAssignment[] };
      const assignments = params.carriers;
      const sortieKey = ctx.toolCallId ?? "";
      const jobId = buildCarrierJobId("sortie", sortieKey);

      logDebug(
        SORTIE_LOG_CATEGORY_INVOKE,
        `execute start carriers=${assignments?.length ?? 0} ids=${(assignments ?? []).map((a) => a.carrier).join(", ") || "(none)"}`,
      );

      const allIds = new Set(getRegisteredOrder());
      const enabledSet = new Set(enabledIds);
      const validation = validateSortieAssignments({
        expectedCount: params.expected_carrier_count,
        assignments,
        registeredIds: [...allIds],
        enabledIds: [...enabledSet],
        jobId,
        resolveUnavailableReason(carrierId) {
          return isSquadronCarrierEnabled(carrierId)
            ? "assigned to squadron (use carrier_squadron instead)"
            : !isSortieCarrierEnabled(carrierId)
              ? "manually disabled"
              : "unavailable";
        },
      });
      if (validation.rejection) {
        logDebug(SORTIE_LOG_CATEGORY_ERROR, `carrier unavailable error=${validation.rejection.error}`);
        return launchResponseResult(validation.rejection);
      }

      logDebug(
        SORTIE_LOG_CATEGORY_VALIDATE,
        `validated carriers=${assignments.length} ids=${assignments.map((a) => a.carrier).join(", ")}`,
      );

      const launch = startDetachedJob({
        jobKind: "sortie",
        toolName: "carriers_sortie",
        toolCallId: sortieKey,
        startedAt: t0,
        carrierIds: assignments.map((assignment) => assignment.carrier),
        signal: ctx.signal,
      });
      if (!launch.accepted) return launch.response;

      const state = initSortieState(sortieKey, assignments.map((assignment) => assignment.carrier));
      emitJobRegistered(jobId, assignments, sortieKey, t0);

      void runSortieJobInBackground({
        jobId,
        sortieKey,
        assignments,
        state,
        signal: launch.signal,
        cwd,
        permit: launch.permit,
        startedAt: t0,
      });

      logDebug(SORTIE_LOG_CATEGORY_RESULT, `run=${sortieKey} accepted job=${jobId}`);
      return launchResponseResult({ job_id: jobId, accepted: true });
    },
  };
}

async function runSortieJobInBackground(opts: SortieBackgroundOptions): Promise<void> {
  let finalStatus: CarrierJobStatus = "done";
  let finalError: string | undefined;
  let results: CarrierSortieResult[] = [];
  try {
    const settledResults = await Promise.allSettled(
      opts.assignments.map((assignment) => runSortieAssignment(assignment, opts)),
    );
    opts.state.finishedAt = Date.now();
    results = settledResults.map((settled, index) => {
      if (settled.status === "fulfilled") return settled.value;
      return buildSortieErrorResult(opts.assignments[index]!.carrier, settled.reason);
    });
    finalStatus = computeSortieFinalStatus(results) as CarrierJobStatus;
    logDebug(
      SORTIE_LOG_CATEGORY_RESULT,
      `run=${opts.sortieKey} success=${results.filter((r) => r.status === "done").length} failure=${results.filter((r) => r.status !== "done").length}`,
    );
  } catch (error) {
    finalStatus = "error";
    finalError = error instanceof Error ? error.message : String(error);
  } finally {
    const finishedAt = Date.now();
    const summary = buildSortieJobSummary(opts.jobId, opts.startedAt, finishedAt, opts.assignments, results, finalStatus as StoredCarrierJobStatus, finalError);
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
        label: opts.assignments.map((assignment) => resolveCarrierDisplayName(assignment.carrier)).join(", "),
      }),
    });
    clearSortieState(opts.sortieKey);
    logDebug(SORTIE_LOG_CATEGORY_INVOKE, `execute end elapsedMs=${finishedAt - opts.startedAt}`);
  }
}

async function runSortieAssignment(
  assignment: CarrierAssignment,
  opts: SortieBackgroundOptions,
): Promise<CarrierSortieResult> {
  const execStartedAt = Date.now();
  const progress = opts.state.carriers.get(assignment.carrier)!;
  progress.status = "connecting";
  const carrierConfig = getRegisteredCarrierConfig(assignment.carrier);
  const cliType = (carrierConfig?.cliType ?? assignment.carrier) as CliType;
  const composedRequest = carrierConfig?.carrierMetadata
    ? composeTier2Request(carrierConfig.carrierMetadata, assignment.request)
    : assignment.request;
  let sessionId: string | undefined;

  logDebug(
    SORTIE_LOG_CATEGORY_DISPATCH,
    [
      `carrier=${assignment.carrier} model=${cliType} promptChars=${composedRequest.length} run=${opts.sortieKey}`,
      "----- BEGIN REQUEST -----",
      composedRequest,
      "----- END REQUEST -----",
    ].join("\n"),
    { hideFromFooter: true, category: "prompt" },
  );

  emitStreamEvent({
    type: "track:begin",
    jobId: opts.jobId,
    trackId: assignment.carrier,
    requestPreview: composedRequest.trim().split(/\r?\n/, 1)[0],
  });

  try {
    const result = await executeWithPool({
      cliType,
      carrierId: assignment.carrier,
      request: composedRequest,
      cwd: opts.cwd,
      connectSystemPrompt: buildCarrierSystemPrompt(),
      signal: opts.signal,
      onConnected: (info) => {
        sessionId = info.sessionId;
      },
      onStatusChange: (status) => {
        emitTrackStatus(opts.jobId, assignment.carrier, status);
      },
      onMessageChunk: (text) => {
        const cleanText = sanitizeChunk(text);
        progress.status = "streaming";
        progress.lineCount++;
        appendBlock(opts.jobId, toMessageArchiveBlock(assignment.carrier, text));
        emitStreamEvent({ type: "track:text", jobId: opts.jobId, trackId: assignment.carrier, text: cleanText });
      },
      onThoughtChunk: (text) => {
        const cleanText = sanitizeChunk(text);
        appendBlock(opts.jobId, toThoughtArchiveBlock(assignment.carrier, text));
        emitStreamEvent({ type: "track:thought", jobId: opts.jobId, trackId: assignment.carrier, text: cleanText });
      },
      onToolCall: (toolTitle, toolStatus, _rawOutput, toolCallId) => {
        progress.status = "streaming";
        progress.toolCallCount++;
        const title = sanitizeToolLabel(toolTitle);
        const status = sanitizeToolLabel(toolStatus);
        logDebug(SORTIE_LOG_CATEGORY_STREAM, `carrier=${assignment.carrier} type=toolCall title=${title} status=${status}`, { hideFromFooter: true });
        emitStreamEvent({ type: "track:tool", jobId: opts.jobId, trackId: assignment.carrier, title, status, toolCallId });
      },
    });
    const finalStatus = toCarrierJobStatus(result.status);
    progress.status = finalStatus === "done" ? "done" : "error";
    emitStreamEvent({
      type: "track:finalized",
      jobId: opts.jobId,
      trackId: assignment.carrier,
      status: toTrackFinalStatus(finalStatus),
      sessionId,
      fallbackText: sanitizeChunk(result.responseText),
      fallbackThought: sanitizeChunk(result.thoughtText),
      error: finalStatus === "aborted" ? "aborted" : result.error,
    });
    logDebug(SORTIE_LOG_CATEGORY_EXEC, `carrier=${assignment.carrier} success=${result.status === "done"} status=${result.status} elapsedMs=${Date.now() - execStartedAt}`);
    return {
      carrierId: assignment.carrier,
      displayName: resolveCarrierDisplayName(assignment.carrier),
      status: finalStatus,
      responseText: result.responseText || "(no output)",
      sessionId,
      error: result.error,
      thinking: result.thoughtText,
      toolCalls: result.toolCalls,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitStreamEvent({
      type: "track:finalized",
      jobId: opts.jobId,
      trackId: assignment.carrier,
      status: "err",
      error: message,
    });
    logDebug(SORTIE_LOG_CATEGORY_EXEC, `carrier=${assignment.carrier} success=false status=error elapsedMs=${Date.now() - execStartedAt}`);
    throw error;
  }
}

function emitJobRegistered(
  jobId: string,
  assignments: CarrierAssignment[],
  sortieKey: string,
  startedAt: number,
): void {
  const tracks: TrackMeta[] = assignments.map((assignment) => ({
    trackId: assignment.carrier,
    streamKey: assignment.carrier,
    displayCli: assignment.carrier,
    displayName: resolveCarrierDisplayName(assignment.carrier),
    kind: "carrier",
  }));
  emitStreamEvent({
    type: "job:registered",
    jobId,
    kind: "sortie",
    ownerCarrierId: assignments[0]!.carrier,
    label: `${assignments.length} carrier${assignments.length === 1 ? "" : "s"}`,
    startedAt,
    activeJobToolCallId: sortieKey,
    tracks,
  });
}

function emitTrackStatus(jobId: string, trackId: string, status: AgentStatus): void {
  emitStreamEvent({
    type: "track:status",
    jobId,
    trackId,
    status: toTrackStatus(status),
  });
}

function toCarrierJobStatus(status: AgentStatus): CarrierJobStatus {
  if (status === "done") return "done";
  if (status === "aborted") return "aborted";
  return "error";
}

function toTrackStatus(status: AgentStatus): TrackStatus {
  if (status === "connecting") return "conn";
  if (status === "running") return "stream";
  if (status === "done") return "done";
  if (status === "aborted") return "aborted";
  return "err";
}

function toTrackFinalStatus(status: CarrierJobStatus): TrackStatus {
  if (status === "done") return "done";
  if (status === "aborted") return "aborted";
  return "err";
}

function buildSortieErrorResult(carrierId: string, reason: unknown): CarrierSortieResult {
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  logDebug(SORTIE_LOG_CATEGORY_ERROR, `carrier=${carrierId} message=${errorMessage}`);
  return {
    carrierId,
    displayName: resolveCarrierDisplayName(carrierId),
    status: "error",
    responseText: `Error: ${errorMessage}`,
    error: errorMessage,
  };
}

function initSortieState(sortieKey: string, carrierIds: string[]): SortieState {
  const state: SortieState = {
    sortieKey,
    carriers: new Map(
      carrierIds.map((id) => [id, { status: "queued", toolCallCount: 0, lineCount: 0 }]),
    ),
    startedAt: Date.now(),
  };
  sortieStateStore.set(sortieKey, state);
  return state;
}

function clearSortieState(sortieKey: string): void {
  sortieStateStore.delete(sortieKey);
}

function formatSortieRenderPayload(assignments: CarrierAssignment[]): string {
  if (assignments.length === 0) {
    return `${SORTIE_SUMMARY_COLOR}...${ANSI_RESET}`;
  }

  return assignments
    .map((assignment) => `${SORTIE_SUMMARY_COLOR}${assignment.carrier}${ANSI_RESET}`)
    .join(`${SORTIE_SUMMARY_COLOR}, ${ANSI_RESET}`);
}

function logDebug(category: string, message: string, options?: unknown): void {
  getLogAPI().debug(category, message, options as LogOptions | undefined);
}
