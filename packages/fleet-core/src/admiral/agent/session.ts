/**
 * admiral/agent/session — ACP 세션 공개 API.
 *
 * ensure: 세션 확보/재사용 → SessionHandle
 * sendMessage: 프롬프트 전송 + AgentStreamEvent emit
 * deliverToolResults: FIFO toolResult 전달
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import type { CliType } from "@sbluemin/unified-agent";

import type { SendMessageRequest, SessionHandle } from "./types.js";
import { hashSystemPrompt } from "./models.js";
import {
  setBridgeScopeSession,
  getOrInitState,
  type AgentSessionState,
} from "./internal/state.js";
import {
  ensureSession,
  sendMessage as engineSendMessage,
  deliverToolResults as engineDeliverToolResults,
  type ToolResultEnvelope,
} from "./internal/session-engine.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export interface EnsureOptions {
  readonly cli: CliType;
  readonly backendModel: string;
  readonly scopeKey: string;
  readonly cwd: string;
  readonly systemPrompt?: string;
  readonly effort?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** 세션 확보 — 기존 세션 재사용 또는 신규 연결. AbortSignal 의미론 보존. */
export async function ensure(opts: EnsureOptions): Promise<SessionHandle> {
  const systemPrompt = opts.systemPrompt ?? undefined;
  const systemPromptHash = hashSystemPrompt(systemPrompt);
  const DEFAULT_BRIDGE_SCOPE = "default";
  const effortOverrides = opts.effort ? { effort: opts.effort } : undefined;

  const result = await ensureSession(
    opts.cli,
    opts.backendModel,
    opts.scopeKey,
    opts.cwd,
    systemPrompt,
    systemPromptHash,
    effortOverrides,
  );

  if (result.isNewSession && result.session.sessionId) {
    setBridgeScopeSession(DEFAULT_BRIDGE_SCOPE, result.session.sessionKey);
    registerSessionLookup(result.session);
  }

  return { sessionId: result.session.sessionId ?? "" };
}

/**
 * 프롬프트 전송 — fleet-core가 firstPromptSent 분기 + buildInitialPrompt/buildRuntimeContextPrompt 적용을
 * 자체 처리한다. host adapter는 raw userRequest와 history만 전달.
 * AgentStreamEvent가 events 채널로 emit됨. abort 시 cancelPrompt만, 세션 유지.
 */
export async function sendMessage(
  handle: SessionHandle,
  request: SendMessageRequest,
  signal?: AbortSignal,
): Promise<void> {
  const session = resolveSession(handle.sessionId);
  if (!session) throw new Error(`세션을 찾을 수 없습니다: ${handle.sessionId}`);
  return engineSendMessage(session, request, signal);
}

/** FIFO toolResult 전달 */
export async function deliverToolResults(
  handle: SessionHandle,
  results: ToolResultEnvelope[],
  signal?: AbortSignal,
): Promise<void> {
  const session = resolveSession(handle.sessionId);
  if (!session) throw new Error(`세션을 찾을 수 없습니다: ${handle.sessionId}`);
  return engineDeliverToolResults(session, results, signal);
}

/** sessionId로 내부 세션 조회 — internal 모듈 전용 */
export function resolveSession(sessionId: string): AgentSessionState | undefined {
  if (!sessionId) return undefined;
  const state = getOrInitState();
  for (const session of state.sessions.values()) {
    if (session.sessionId === sessionId) return session;
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal
// ═══════════════════════════════════════════════════════════════════════════

/** sessionId → 세션 빠른 룩업 (ensure 직후 사용 보장) */
const sessionLookup = new Map<string, AgentSessionState>();

function registerSessionLookup(session: AgentSessionState): void {
  if (session.sessionId) {
    sessionLookup.set(session.sessionId, session);
  }
}
