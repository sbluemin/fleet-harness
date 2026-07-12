/**
 * dispatch/tool-spec.ts — carrier_dispatch 단일 도구 스펙
 *
 * 모든 캐리어를 단일 carrier_dispatch 도구로 통합합니다.
 */

import path from "node:path";

import { Type } from "typebox";
import type { CliType } from "@dotobokuri/core-unified-agent";

import type { AgentToolSpec, OneShotExecution, OneShotReady } from "@dotobokuri/core-agent";
import type { CarrierJobStatus as StoredCarrierJobStatus } from "../jobs/types.js";
import type { JobPermitAccepted } from "../jobs/lifecycle.js";
import type { CarrierDispatchServices } from "../index.js";
import type {
  CarrierJobStatus,
  CarrierMetadata,
  TrackMeta,
  TrackStatus,
} from "./types.js";

import { appendBlock, toArchiveBlock } from "../jobs/archive.js";
import { buildCarrierResultSystemReminder } from "../jobs/dispatch.js";
import { finalizeDetachedJob, launchResponseResult, rollbackRejectedDetachedJob, startDetachedJob } from "../jobs/lifecycle.js";
import { sanitizeChunk, sanitizeProviderReason, sanitizeToolLabel } from "../jobs/sanitize.js";
import { buildCarrierJobId, buildJobSummary } from "../jobs/types.js";
import { captureJobWindowManifest, captureWorkspaceSnapshot } from "../jobs/workspace-manifest.js";
import { executeOneShot } from "@dotobokuri/core-agent";
import {
  getConfiguredTaskForceBackends,
  loadCarrierStates,
} from "../store/index.js";
import { launchTaskForceJob } from "./taskforce.js";
import {
  claimDispatchContext,
  commitDispatchLease,
  confirmDispatchReadiness,
  RESUME_CONTEXT_ID_DESCRIPTION,
  releaseDispatchLease,
  type DispatchBackendSession,
  type DispatchContextBindingInput,
  type DispatchContextLease,
} from "./context-registry.js";
import {
  buildCarrierSystemPrompt,
  formatRequestBlocksGuide,
  validateRequiredRequestBlocks,
  type CarrierToolSpecDeps,
} from "./prompt.js";
import {
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  emitStreamEvent,
  resolveAgentCliType,
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

interface SingleCarrierFinalizeOptions {
  registry: CarrierRegistry;
  jobId: string;
  carrierId: string;
  originSessionId?: string;
  trackModelInfo: CarrierTrackModelInfo;
  label: string;
  request: string;
  cwd: string;
  permit: JobPermitAccepted;
  startedAt: number;
  toolName: `carrier_${string}`;
  deps: CarrierToolSpecDeps;
  services?: CarrierDispatchServices;
  lease?: DispatchContextLease;
  contextId?: string;
  ready: OneShotReady;
  handle: OneShotExecution;
}

interface CarrierTrackModelInfo {
  readonly cliType: CliType;
  readonly effort?: string;
  readonly model: string;
}

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
  /**
   * 렌더 계층. 생략 시 전체 렌더(기존 동작).
   * - "routing": 선택·라우팅 메타만 — request-block 계약을 제외한다 (상시 시스템 프롬프트용).
   * - "contracts": request-block 계약만 — 선택·라우팅 메타를 제외한다 (온디맨드 스킬 본문용).
   */
  tier?: "routing" | "contracts";
}

// ═════════════════════════════════════════════════════════
// Constants
// ═════════════════════════════════════════════════════════

/** carrier_dispatch request brevity 정책 SSoT — Host(Admiral)의 비대 request 안티패턴 억제. */
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
export function buildCarrierDispatchToolSpec(registry: CarrierRegistry, deps: CarrierToolSpecDeps, services?: CarrierDispatchServices): AgentToolSpec {
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
        ` Launch response schema is { job_id, context_id?, accepted, error? } and never includes synchronous result content.` +
        ` Full output is available only through carrier_jobs(action:"result", format:"full"), is finalized-only, and remains read-many for 6h.`,
      `Do not poll, wait-check, or call carrier_jobs merely to see whether the job is done.` +
        ` Continue independent work if available; otherwise stop tool use and wait passively for the [carrier:result] follow-up push.`,
      `Some carriers require structured request blocks (e.g., <objective>, <context>).` +
        ` The per-carrier request-block contract lives in the carrier-contracts skill —` +
        ` load it before composing a dispatch (skip reloading if its content is already in context).` +
        ` Missing required tags cause hard-error rejection that echoes the carrier's block contract.`,
      `Every successful fresh dispatch returns context_id. To continue that real provider session later,` +
        ` wait for completion and pass that value as resume_context_id; omit resume_context_id to start fresh.`,
      CARRIER_REQUEST_BREVITY_GUIDELINE,
    ],
    guardrails: [
      `Multiple agents may be working on this codebase at the same time on a single filesystem and branch.` +
        ` Only touch changes you made — never revert or overwrite modifications made by others.` +
        ` Prefer precise edits (edit) over full-file writes (write).` +
        ` Always re-read a file before modifying it, as it may have changed since your last read.`,
      `When the carrier must work in a directory other than the host session cwd (e.g. a git worktree checkout),` +
        ` pass cwd as an absolute path so the carrier's CLI spawns there; never pass a relative path.` +
        ` Omit cwd to use the host session cwd.`,
    ],
    get parameters() {
      const carrierIds = getRegisteredOrder(registry);
      return Type.Object({
        carrier_id: Type.String({
          enum: carrierIds,
          description: `The target carrier ID to dispatch the job to. See <fleet section="roster"> for available carriers.`,
        }),
        label: Type.String({
          description: `Required concise one-line dispatch intent label. Describe the work intent, e.g. "Audit panel run identity"; do not use the carrier name and do not paste the full request.`,
        }),
        request: Type.String({
          description:
            `The task/prompt to send to the carrier. Required blocks per carrier -- see the carrier-contracts skill.` +
            ` Missing blocks cause hard-error rejection.`,
        }),
        cwd: Type.Optional(Type.String({
          description:
            `Optional absolute working directory for the carrier's CLI spawn.` +
            ` MUST be an absolute path. Provide it when delegating work to a directory other than the host session cwd` +
            ` (e.g. a git worktree checkout) so the carrier spawns deterministically at that path.` +
            ` Omit to default to the host session cwd.`,
        })),
        resume_context_id: Type.Optional(Type.String({
          description: RESUME_CONTEXT_ID_DESCRIPTION,
        })),
      });
    },

    async execute(args: unknown, ctx) {
      const t0 = Date.now();
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

      // 명시 cwd 해석 — 절대경로만 허용하고, 미전달 시 호스트 세션 cwd로 fallback한다.
      const cwdResolution = resolveDispatchCwd(args.cwd, ctx.cwd);
      if (!cwdResolution.ok) {
        return launchResponseResult({ job_id: jobId, accepted: false, error: cwdResolution.error });
      }
      const cwd = cwdResolution.cwd;

      const carrierId = args.carrier_id.trim();
      const label = args.label.trim();
      const request = args.request;


      const config = getRegisteredCarrierConfig(registry, carrierId);
      if (!config) {
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
          cwd,
          deps,
          services,
          resumeContextId: args.resume_context_id,
        });
      }

      let trackModelInfo: CarrierTrackModelInfo;
      try {
        trackModelInfo = resolveCarrierTrackModelInfo(registry, carrierId);
      } catch (error) {
        return launchResponseResult({
          job_id: jobId,
          accepted: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // 입력이 없으면 새 context_id를 발급하고, 있으면 해당 provider 세션을 명시 재개한다.
      const binding: DispatchContextBindingInput = {
        carrierId,
        cwd,
        shape: "single",
        backends: [{ cliType: trackModelInfo.cliType }],
      };
      const claim = claimDispatchContext(services?.dispatchContexts, args.resume_context_id, binding);
      if (!claim.ok) {
        return launchResponseResult({ job_id: jobId, accepted: false, error: claim.error });
      }

      const launch = startDetachedJob({
        jobKind: "carrier",
        toolName,
        toolCallId,
        startedAt: t0,
        carrierIds: [carrierId],
        signal: ctx.signal,
      });
      if (!launch.accepted) {
        releaseDispatchLease(services?.dispatchContexts, claim.lease);
        return launch.response;
      }

      const carrierConfig = getRegisteredCarrierConfig(registry, carrierId);
      const handle = executeOneShot({
        scopeId: carrierId,
        authEnvResolver: deps.authEnvResolver,
        reservedExternalMcpServerIds: deps.reservedExternalMcpServerIds,
        cliType: trackModelInfo.cliType,
        request,
        cwd,
        model: trackModelInfo.model,
        effort: trackModelInfo.effort,
        resumeSessionId: claim.resumeSessions?.get(trackModelInfo.cliType),
        connectSystemPrompt: buildCarrierSystemPrompt(carrierConfig?.carrierMetadata),
        signal: launch.signal,
        ...buildSingleTrackListeners(registry, launch.jobId, carrierId, ctx.sessionLabel),
      });

      // 런치 응답은 readiness(연결/재개·MCP·프로토콜 확인)까지 대기하되, 프롬프트 완료는 백그라운드로 분리한다.
      let ready: OneShotReady;
      try {
        ready = await handle.readiness;
        confirmDispatchReadiness(services?.dispatchContexts, claim.lease, [readyToSession(ready)]);
      } catch (error) {
        await rollbackRejectedDetachedJob({ jobId: launch.jobId, permit: launch.permit, abort: () => handle.abort() });
        releaseDispatchLease(services?.dispatchContexts, claim.lease);
        return launchResponseResult({
          job_id: launch.jobId,
          accepted: false,
          error: sanitizeProviderReason(error instanceof Error ? error.message : String(error)),
        });
      }

      emitJobRegistered(registry, launch.jobId, carrierId, ctx.sessionLabel, toolCallId, label, t0, trackModelInfo);
      emitStreamEvent(registry, {
        type: "track:begin",
        jobId: launch.jobId,
        originSessionId: ctx.sessionLabel,
        trackId: carrierId,
        startedAt: Date.now(),
        requestPreview: request.trim().split(/\r?\n/, 1)[0],
      });
      handle.startPrompt();

      const completion = finalizeSingleCarrierJob({
        registry,
        jobId: launch.jobId,
        carrierId,
        originSessionId: ctx.sessionLabel,
        trackModelInfo,
        label,
        request,
        cwd,
        permit: launch.permit,
        startedAt: t0,
        toolName,
        deps,
        services,
        lease: claim.lease,
        contextId: claim.contextId,
        ready,
        handle,
      });
      const untrack = services?.trackInFlight?.({ cancel: () => handle.abort(), completion }) ?? (() => {});
      void completion.finally(untrack);

      return launchResponseResult({
        job_id: launch.jobId,
        ...(claim.contextId ? { context_id: claim.contextId } : {}),
        accepted: true,
      });
    },
  };
}

// ═════════════════════════════════════════════════════════
// 내부 헬퍼
// ═════════════════════════════════════════════════════════

/** Streaming listeners for a single-carrier one-shot handle — emit track events and archive output. */
function buildSingleTrackListeners(
  registry: CarrierRegistry,
  jobId: string,
  carrierId: string,
  originSessionId: string | undefined,
) {
  return {
    onStatusChange: (status: TrackStatus) => {
      emitStreamEvent(registry, { type: "track:status", jobId, originSessionId, trackId: carrierId, status });
    },
    onMessageChunk: (text: string) => {
      const cleanText = sanitizeChunk(text);
      appendBlock(jobId, toArchiveBlock("text", carrierId, text));
      emitStreamEvent(registry, { type: "track:text", jobId, originSessionId, trackId: carrierId, text: cleanText });
    },
    onThoughtChunk: (text: string) => {
      const cleanText = sanitizeChunk(text);
      appendBlock(jobId, toArchiveBlock("thought", carrierId, text));
      emitStreamEvent(registry, { type: "track:thought", jobId, originSessionId, trackId: carrierId, text: cleanText });
    },
    onToolCall: (toolTitle: string, toolStatus: string, rawOutput?: string, toolCallId?: string) => {
      const title = sanitizeToolLabel(toolTitle);
      const status = sanitizeToolLabel(toolStatus);
      emitStreamEvent(registry, {
        type: "track:tool",
        jobId,
        originSessionId,
        trackId: carrierId,
        detailChars: rawOutput?.length ?? 0,
        title,
        status,
        toolCallId,
      });
    },
  };
}

function readyToSession(ready: OneShotReady): DispatchBackendSession {
  return { cliType: ready.cliType, protocol: ready.protocol, sessionId: ready.sessionId };
}

/**
 * Drive a single-carrier one-shot handle to completion after its prompt gate opens.
 * Emits the finalized track/job events, records the workspace manifest, and commits the
 * dispatch mapping only on a `done` turn (any other outcome unlocks without committing).
 */
async function finalizeSingleCarrierJob(opts: SingleCarrierFinalizeOptions): Promise<void> {
  let finalStatus: CarrierJobStatus = "done";
  let finalError: string | undefined;
  let result: CarrierSingleResult | undefined;
  const baselineSnapshot = await captureWorkspaceSnapshot(opts.deps.workspaceChangeScanner, opts.cwd);
  try {
    const execResult = await opts.handle.completion;
    finalStatus = toCarrierJobStatus(execResult.status);
    const sessionId = execResult.sessionId ?? opts.ready.sessionId;
    emitStreamEvent(opts.registry, {
      type: "track:finalized",
      jobId: opts.jobId,
      originSessionId: opts.originSessionId,
      trackId: opts.carrierId,
      status: toTrackFinalStatus(finalStatus),
      finishedAt: Date.now(),
      sessionId,
      fallbackText: sanitizeChunk(execResult.responseText),
      fallbackThought: sanitizeChunk(execResult.thoughtText),
      error: finalStatus === "aborted" ? "aborted" : execResult.error,
    });
    result = {
      carrierId: opts.carrierId,
      displayName: resolveCarrierDisplayName(opts.registry, opts.carrierId),
      status: finalStatus,
      responseText: execResult.responseText || "(no output)",
      sessionId,
      error: execResult.error,
      thinking: execResult.thoughtText,
      toolCalls: execResult.toolCalls.map((tc) => ({ title: tc.title, status: tc.status })),
    };
    if (finalStatus === "error") finalError = execResult.error ?? execResult.responseText;
    if (finalStatus === "done") {
      commitDispatchLease(opts.services?.dispatchContexts, opts.lease, [readyToSession(opts.ready)]);
    } else {
      releaseDispatchLease(opts.services?.dispatchContexts, opts.lease);
    }
  } catch (error) {
    finalStatus = "error";
    finalError = error instanceof Error ? error.message : String(error);
    emitStreamEvent(opts.registry, {
      type: "track:finalized",
      jobId: opts.jobId,
      originSessionId: opts.originSessionId,
      trackId: opts.carrierId,
      status: "err",
      finishedAt: Date.now(),
      error: finalError,
    });
    releaseDispatchLease(opts.services?.dispatchContexts, opts.lease);
  } finally {
    const finishedAt = Date.now();
    const workspaceChanges = await captureJobWindowManifest(opts.deps.workspaceChangeScanner, opts.cwd, baselineSnapshot);
    const results = result
      ? [result]
      : [{ carrierId: opts.carrierId, displayName: resolveCarrierDisplayName(opts.registry, opts.carrierId), status: "error" as CarrierJobStatus, responseText: finalError ?? "Unknown error", error: finalError }];
    const summary = buildJobSummary({
      jobId: opts.jobId,
      startedAt: opts.startedAt,
      finishedAt,
      carriers: [opts.carrierId],
      results,
      status: finalStatus as StoredCarrierJobStatus,
      error: finalError,
      tool: opts.toolName,
      prefix: "carrier job",
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
        kind: "carrier",
        status: finalStatus as StoredCarrierJobStatus,
        summary,
        error: finalError,
        label: opts.label,
        contextId: opts.contextId,
        resumeAvailable: finalStatus === "done",
      }),
    });
  }
}

function emitJobRegistered(
  registry: CarrierRegistry,
  jobId: string,
  carrierId: string,
  originSessionId: string | undefined,
  sortieKey: string,
  label: string,
  startedAt: number,
  trackModelInfo: CarrierTrackModelInfo,
): void {
  const runId = buildCarrierDispatchRunId(jobId, carrierId);
  const tracks: TrackMeta[] = [{
    trackId: carrierId,
    streamKey: carrierId,
    displayCli: carrierId,
    displayName: resolveCarrierDisplayName(registry, carrierId),
    effort: trackModelInfo.effort,
    kind: "carrier",
    model: trackModelInfo.model,
    runId,
    startedAt,
  }];
  emitStreamEvent(registry, {
    type: "job:registered",
    jobId,
    originSessionId,
    kind: "carrier",
    ownerCarrierId: carrierId,
    label,
    startedAt,
    activeJobToolCallId: sortieKey,
    tracks,
  });
}

function resolveCarrierTrackModelInfo(registry: CarrierRegistry, carrierId: string): CarrierTrackModelInfo {
  const carrierConfig = getRegisteredCarrierConfig(registry, carrierId);
  const cliType = carrierConfig
    ? resolveAgentCliType(carrierId, carrierConfig.defaultCliType)
    : (carrierId as CliType);
  const modelConfig = loadCarrierStates({
    [carrierId]: carrierConfig
      ? {
        cliType,
        ...(carrierConfig.defaultEffort ? { defaultEffort: carrierConfig.defaultEffort } : {}),
        ...(carrierConfig.defaultModel ? { defaultModel: carrierConfig.defaultModel } : {}),
      }
      : cliType,
  })[carrierId];
  const agentCli = modelConfig?.agentCli[cliType];
  const model = agentCli?.model;
  if (!model) throw new Error(`Carrier model config missing for "${carrierId}".`);
  return {
    cliType,
    model,
    effort: resolveValidatedEffort(cliType, model, agentCli?.effort),
  };
}

function buildCarrierDispatchRunId(jobId: string, carrierId: string): string {
  return `${jobId}:${carrierId}`;
}

function isDispatchArgs(v: unknown): v is { carrier_id: string; label: string; request: string; cwd?: string; resume_context_id?: string } {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.carrier_id === "string" &&
    obj.carrier_id.trim().length > 0 &&
    typeof obj.label === "string" &&
    obj.label.trim().length > 0 &&
    typeof obj.request === "string" &&
    obj.request.trim().length > 0 &&
    (obj.cwd === undefined || typeof obj.cwd === "string") &&
    (obj.resume_context_id === undefined || typeof obj.resume_context_id === "string")
  );
}

/**
 * carrier_dispatch가 전달받은 명시 cwd를 해석한다.
 * - 미전달/빈 문자열: 호스트 세션 cwd(fallbackCwd)로 fallback해 하위 호환을 유지한다.
 * - 절대경로: 그대로 사용해 결정론적 스폰 지점을 강제한다.
 * - 상대경로: "어디 기준?" 모호성을 차단하기 위해 거절한다(존재성 검증은 spawn 자연 실패에 위임).
 */
function resolveDispatchCwd(
  rawCwd: string | undefined,
  fallbackCwd: string,
): { ok: true; cwd: string } | { ok: false; error: string } {
  if (rawCwd === undefined) return { ok: true, cwd: fallbackCwd };
  const trimmed = rawCwd.trim();
  if (trimmed.length === 0) return { ok: true, cwd: fallbackCwd };
  if (!path.isAbsolute(trimmed)) {
    return {
      ok: false,
      error: `Invalid cwd "${rawCwd}": must be an absolute path. Provide an absolute directory or omit cwd to use the host session cwd.`,
    };
  }
  return { ok: true, cwd: trimmed };
}

// ═════════════════════════════════════════════════════════
// 로스터 렌더링
// ═════════════════════════════════════════════════════════

export function buildCarrierRoster(
  registry: CarrierRegistry,
  carrierIds: string[],
  options?: CarrierRosterOptions,
): string {
  const { excludeCarrierIds, heading, preambleLines, extraLines, tier } = options ?? {};
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
      if (tier === "contracts") {
        lines.push(`- **${carrierId}** (${config.displayName}): free-form request body — no structured request blocks.`);
        continue;
      }
      lines.push(`- **${carrierId}** (${config.displayName}): Delegate tasks to ${config.displayName}.`);
      lines.push(`  carrier_id: "${carrierId}"`);
      if (extraLines) {
        const extras = extraLines(carrierId, undefined);
        for (const e of extras) lines.push(e);
      }
      continue;
    }

    const name = config.displayName;
    if (tier === "contracts") {
      const blockLines = formatRequestBlocksGuide(meta);
      if (blockLines.length === 0) {
        lines.push(`- **${carrierId}** (${name} · ${meta.title}): free-form request body — no structured request blocks.`);
        continue;
      }
      lines.push(`- **${carrierId}** (${name} · ${meta.title}) — wrap request content in these blocks (? = optional):`);
      lines.push(...blockLines);
      continue;
    }

    lines.push(`- **${carrierId}** (${name} · ${meta.title}): ${meta.summary}`);
    lines.push(`  carrier_id: "${carrierId}"`);
    lines.push(`  Use for: ${meta.whenToUse.join(", ")}.`);
    if (meta.whenNotToUse.length > 0) {
      lines.push(`  NOT for:`);
      for (const item of meta.whenNotToUse) {
        lines.push(`    - ${item}`);
      }
    }
    if (tier !== "routing") {
      const blockLines = formatRequestBlocksGuide(meta);
      if (blockLines.length > 0) {
        lines.push(`  Request blocks — wrap content in these (? = optional):`);
        lines.push(...blockLines);
      }
    }
    if (extraLines) {
      const extras = extraLines(carrierId, meta);
      for (const e of extras) lines.push(e);
    }
  }

  return lines.join("\n");
}
