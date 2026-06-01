/**
 * carrier/tool-spec.ts — carrier_dispatch 단일 도구 스펙
 *
 * 모든 캐리어를 단일 carrier_dispatch 도구로 통합합니다.
 */

import { Type } from "typebox";
import type { CliType } from "@dotobokuri/fleet-unified-agent";

import type { AgentToolSpec } from "@dotobokuri/fleet-mcp-server";
import type { CarrierJobStatus as StoredCarrierJobStatus } from "../jobs/types.js";
import type { JobPermitAccepted } from "../jobs/lifecycle.js";
import type {
  CarrierJobStatus,
  CarrierMetadata,
  RequestBlock,
  TrackMeta,
} from "./types.js";

import { appendBlock, toArchiveBlock } from "../jobs/archive.js";
import { buildCarrierResultSystemReminder } from "../jobs/dispatch.js";
import { launchResponseResult } from "../jobs/lifecycle.js";
import { finalizeDetachedJob, startDetachedJob } from "../jobs/lifecycle.js";
import { sanitizeChunk, sanitizeToolLabel } from "../jobs/sanitize.js";
import { buildCarrierJobId, buildJobSummary, computeFinalStatus } from "../jobs/types.js";
import { executeWithPool } from "@dotobokuri/fleet-infra/agent";
import {
  getConfiguredTaskForceBackends,
  isCarrierSubagentModeEnabled,
  loadModels,
} from "../store/index.js";
import { launchTaskForceJob } from "./taskforce.js";
import {
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  emitStreamEvent,
  logDebug,
  resolveCarrierCliType,
  resolveCarrierDisplayName,
  resolveValidatedEffort,
  toCarrierJobStatus,
  toTrackFinalStatus,
  type CarrierRegistry,
} from "./framework.js";

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

/** 검증 성공 결과 */
export interface RequiredBlockValidationOk {
  ok: true;
}

/** 검증 실패 결과 */
export interface RequiredBlockValidationFail {
  ok: false;
  missing: string[];
  error: string;
}

export type RequiredBlockValidationResult =
  | RequiredBlockValidationOk
  | RequiredBlockValidationFail;

/** buildCarrierRoster 호출 시 각 caller별 차이를 조정하는 옵션 */
export interface CarrierRosterOptions {
  /** 로스터에서 제외할 carrier ID 목록 */
  excludeCarrierIds?: readonly string[];
  /** 로스터 섹션 제목 (기본: "## Available Carriers") */
  heading?: string;
  /** 로스터 본문 앞에 추가할 안내 라인들 */
  preambleLines?: string[];
  /** 특정 carrierId에 대해 로스터 엔트리 뒤에 추가할 라인 생성기 */
  extraLines?: (carrierId: string, meta: CarrierMetadata | undefined) => string[];
}

export interface CarrierSortieOutcome {
  readonly carrierId: string;
  readonly status: "done" | "error" | "aborted";
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
const CARRIER_FLEET_BACKGROUND = String.raw`You are an autonomous agent (Carrier) operating within a coordinated multi-agent Fleet system. The Admiral, your superior, dispatches specialized tasks to you and synthesizes your output for the user. Below is your identity, operational permissions, behavioral principles, and required output format. Your assigned task arrives in the user message channel below.`;

/** carrier_dispatch request brevity 정책 SSoT — Host PI(Admiral)의 비대 request 안티패턴 억제. */
export const CARRIER_REQUEST_BREVITY_GUIDELINE =
  `Each request body MUST be ≤ ~300 words and each request block MUST be ≤ 5 sentences.` +
  ` MUST NOT paraphrase or copy your own analysis, reconnaissance output, or system-prompt content into the request.` +
  ` When referencing prior carrier work, pass the job_id(s) via <prior_jobs> instead of paraphrasing their output` +
  ` — the carrier will self-fetch full results using carrier_jobs(action:"result", format:"full", job_id:...).` +
  ` If archive content has expired (full_invalidated true / TTL exceeded), the carrier falls back to` +
  ` carrier_jobs(action:"result", format:"summary", job_id:...) to retrieve the summary.`;

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

      if (isCarrierSubagentModeEnabled(carrierId)) {
        const displayName = resolveCarrierDisplayName(registry, carrierId);
        logDebug(CARRIER_LOG_CATEGORY_ERROR, `carrier subagent mode enabled carrier=${carrierId}`);
        return launchResponseResult({
          job_id: jobId,
          accepted: false,
          error: `Carrier "${carrierId}" is in native subagent mode and is unreachable via carrier_dispatch. Invoke it directly as the native subagent "${displayName}".`,
        });
      }

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
    const summary = buildJobSummary({
      jobId: opts.jobId,
      startedAt: opts.startedAt,
      finishedAt,
      carriers: assignments.map((assignment) => assignment.carrier),
      results,
      status: finalStatus as StoredCarrierJobStatus,
      error: finalError,
      tool: opts.toolName,
      prefix: "carrier job",
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

  emitStreamEvent(opts.registry, {
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
        emitStreamEvent(opts.registry, { type: "track:status", jobId: opts.jobId, trackId: opts.carrierId, status });
      },
      onMessageChunk: (text) => {
        const cleanText = sanitizeChunk(text);
        appendBlock(opts.jobId, toArchiveBlock("text", opts.carrierId, text));
        emitStreamEvent(opts.registry, { type: "track:text", jobId: opts.jobId, trackId: opts.carrierId, text: cleanText });
      },
      onThoughtChunk: (text) => {
        const cleanText = sanitizeChunk(text);
        appendBlock(opts.jobId, toArchiveBlock("thought", opts.carrierId, text));
        emitStreamEvent(opts.registry, { type: "track:thought", jobId: opts.jobId, trackId: opts.carrierId, text: cleanText });
      },
      onToolCall: (toolTitle, toolStatus, _rawOutput, toolCallId) => {
        const title = sanitizeToolLabel(toolTitle);
        const status = sanitizeToolLabel(toolStatus);
        logDebug(CARRIER_LOG_CATEGORY_STREAM, `carrier=${opts.carrierId} type=toolCall title=${title} status=${status}`, { hideFromFooter: true });
        emitStreamEvent(opts.registry, { type: "track:tool", jobId: opts.jobId, trackId: opts.carrierId, title, status, toolCallId });
      },
    });
    const finalStatus = toCarrierJobStatus(execResult.status);
    emitStreamEvent(opts.registry, {
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
    emitStreamEvent(opts.registry, {
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
  emitStreamEvent(registry, {
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

/**
 * 필수 requestBlock이 request 텍스트에 정상적으로 존재하는지 검사합니다.
 *
 * opening tag, closing tag, 비어 있지 않은 본문을 모두 확인합니다.
 * 속성이 포함된 태그도 허용합니다: `<plan_file source="kirov">...</plan_file>`
 *
 * @param meta carrier 메타데이터
 * @param request 사용자 요청 텍스트
 * @param carrierId 검증 실패 시 에러 메시지에 포함할 carrier 식별자
 */
export function validateRequiredRequestBlocks(
  meta: CarrierMetadata,
  request: string,
  carrierId: string,
): RequiredBlockValidationResult {
  const required = meta.requestBlocks.filter((b) => b.required);
  if (required.length === 0) return { ok: true };

  const missing: string[] = [];
  const details: string[] = [];

  for (const block of required) {
    const escaped = escapeRegExp(block.tag);
    const regex = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`);
    const match = regex.exec(request);
    if (!match) {
      missing.push(block.tag);
      details.push(`<${block.tag}> (missing closing tag)`);
    } else if (!match[1]?.trim()) {
      missing.push(block.tag);
      details.push(`<${block.tag}> (empty body)`);
    }
  }

  if (missing.length === 0) return { ok: true };

  return {
    ok: false,
    missing,
    error:
      `Missing required request block(s) for carrier "${carrierId}": ${details.join(", ")}.` +
      ` Include the required tag(s) in the request and resubmit.`,
  };
}

/** 정규식 특수문자를 이스케이프합니다 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ═════════════════════════════════════════════════════════
// 캐리어 시스템 프롬프트 (Tier 2)
// ═════════════════════════════════════════════════════════

export function buildCarrierSystemPrompt(metadata?: CarrierMetadata): string {
  const parts: string[] = [CARRIER_FLEET_BACKGROUND];

  if (metadata) {
    parts.push(`<your_identity>\n${metadata.title}\n${metadata.summary}\n</your_identity>`);

    if (metadata.permissions.length > 0) {
      const body = metadata.permissions.map((item) => `- ${item}`).join("\n");
      parts.push(`<your_permissions>\n${body}\n</your_permissions>`);
    }

    const principles = metadata.principles ?? [];
    if (principles.length > 0) {
      const body = principles.map((item) => `- ${item}`).join("\n");
      parts.push(`<your_principles>\n${body}\n</your_principles>`);
    }

    if (metadata.outputFormat) {
      parts.push(`<output_format>\n${metadata.outputFormat.trim()}\n</output_format>`);
    }
  }

  return parts.join("\n\n");
}

// ═════════════════════════════════════════════════════════
// 로스터 렌더링
// ═════════════════════════════════════════════════════════

export function buildCarrierRoster(
  registry: CarrierRegistry,
  carrierIds: string[],
  options?: CarrierRosterOptions,
): string {
  const { excludeCarrierIds, heading, preambleLines, extraLines } = options ?? {};
  const excluded = new Set(excludeCarrierIds ?? []);
  const lines: string[] = [];

  lines.push(heading ?? `## Available Carriers`);
  if (preambleLines) {
    for (const p of preambleLines) lines.push(p);
  }

  for (const carrierId of carrierIds) {
    if (excluded.has(carrierId)) continue;
    const config = getRegisteredCarrierConfig(registry, carrierId);
    if (!config) continue;

    const meta = config.carrierMetadata;
    if (!meta) {
      lines.push(`- **${carrierId}** (${config.displayName}): Delegate tasks to ${config.displayName}.`);
      lines.push(`  carrier_id: "${carrierId}"`);
      if (extraLines) {
        const extras = extraLines(carrierId, undefined);
        for (const e of extras) lines.push(e);
      }
      continue;
    }

    const name = config.displayName;
    lines.push(`- **${carrierId}** (${name} · ${meta.title}): ${meta.summary}`);
    lines.push(`  carrier_id: "${carrierId}"`);
    lines.push(`  Use for: ${meta.whenToUse.join(", ")}.`);
    if (meta.whenNotToUse.length > 0) {
      lines.push(`  NOT for:`);
      for (const item of meta.whenNotToUse) {
        lines.push(`    - ${item}`);
      }
    }
    const blockLines = formatRequestBlocksGuide(meta);
    if (blockLines.length > 0) {
      lines.push(`  Request blocks — wrap content in these (? = optional):`);
      lines.push(...blockLines);
    }
    if (extraLines) {
      const extras = extraLines(carrierId, meta);
      for (const e of extras) lines.push(e);
    }
  }

  return lines.join("\n");
}

export function formatRequestBlocksGuide(meta: CarrierMetadata): string[] {
  const allBlocks: RequestBlock[] = [...meta.requestBlocks];
  if (allBlocks.length === 0) return [];
  return allBlocks.map((b) => {
    const sig = b.required ? `<${b.tag}>` : `<${b.tag}?>`;
    const label = b.required ? "required" : "optional";
    return `  - ${sig} ${label}: ${b.hint}`;
  });
}

export { buildJobSummary as buildSortieJobSummary, computeFinalStatus as computeSortieFinalStatus };
