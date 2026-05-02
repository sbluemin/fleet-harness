/**
 * admiral/agent/internal/mcp-router — MCP 토큰 라우팅 및 FIFO 관리.
 *
 * setOnToolCallArrived 호출의 유일 소유자. MCP 토큰은 외부 노출 금지.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import crypto from "node:crypto";

import {
  setOnToolCallArrived,
  clearPendingForSession,
  resolveNextToolCall,
  type McpCallToolResult,
} from "../../_shared/mcp.js";
import {
  registerToolsForSession,
  removeToolsForSession,
  getToolNamesForSession,
} from "../../../services/tool-registry/tool-snapshot.js";
import type { ToolMetadata } from "../types.js";

import type { AgentSessionState, AgentProviderState, PendingToolCallState } from "./state.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

type McpTool = { name: string; description?: string; parameters?: unknown; [key: string]: unknown };

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** 세션 수명 동안 MCP tool call router 설치 — setOnToolCallArrived의 유일 소유자 */
export function installToolCallRouter(
  state: AgentProviderState,
  session: AgentSessionState,
  onToolCallArrived?: (session: AgentSessionState, pending: PendingToolCallState) => void,
): void {
  if (!session.mcpSessionToken) return;
  setOnToolCallArrived(session.mcpSessionToken, (toolName, args) => {
    const pending = registerPendingToolCall(state, session, toolName, args);
    session.pendingToolCallNotifier?.();
    onToolCallArrived?.(session, pending);
    return pending.toolCallId;
  });
}

/** 세션 MCP router 분리 */
export function detachToolCallRouter(session: AgentSessionState): void {
  if (!session.mcpSessionToken) return;
  setOnToolCallArrived(session.mcpSessionToken, null);
}

/** 세션에 MCP tools 등록 */
export function registerSessionTools(
  session: AgentSessionState,
  tools: McpTool[],
): void {
  if (!session.mcpSessionToken) return;
  registerToolsForSession(session.mcpSessionToken, tools);
}

/** 세션 MCP tools 제거 */
export function removeSessionTools(session: AgentSessionState): void {
  if (!session.mcpSessionToken) return;
  removeToolsForSession(session.mcpSessionToken);
}

/** 세션의 pi tool 이름 Set 조회 */
export function getSessionToolNames(session: AgentSessionState): Set<string> {
  if (!session.mcpSessionToken) return new Set();
  return getToolNamesForSession(session.mcpSessionToken);
}

/** ToolMetadata → MCP Tool 포맷 변환 */
export function metadataToMcpTool(meta: ToolMetadata): McpTool {
  return {
    name: meta.name,
    description: meta.description,
    parameters: meta.parameters,
  };
}

/** 논리적 프롬프트 종료 시 router + orphaned MCP 상태 정리 */
export function closeLogicalPromptRouting(
  state: AgentProviderState,
  session: AgentSessionState,
): void {
  if (session.mcpSessionToken) {
    detachToolCallRouter(session);
    clearPendingForSession(session.mcpSessionToken);
  }
  clearSessionRoutingState(state, session);
}

/** 세션 라우팅 상태 정리 */
export function clearSessionRoutingState(
  state: AgentProviderState,
  session: AgentSessionState,
): void {
  for (const pending of session.pendingToolCalls) {
    state.toolCallToSessionKey.delete(pending.toolCallId);
  }
  session.pendingToolCalls = [];
  session.pendingToolCallNotifier = null;
}

/** MCP toolCallId를 세션 FIFO에 등록 */
export function registerPendingToolCall(
  state: AgentProviderState,
  session: AgentSessionState,
  toolName: string,
  args: Record<string, unknown>,
): PendingToolCallState {
  const toolCallId = crypto.randomUUID();
  const pending: PendingToolCallState = {
    toolCallId,
    toolName,
    args,
    emitted: false,
  };
  session.pendingToolCalls.push(pending);
  state.toolCallToSessionKey.set(toolCallId, session.sessionKey);
  return pending;
}

/** FIFO head 소비 */
export function consumePendingToolCall(
  state: AgentProviderState,
  session: AgentSessionState,
  toolCallId: string,
): void {
  const head = session.pendingToolCalls[0];
  if (!head || head.toolCallId !== toolCallId) {
    throw new Error(
      `pending MCP head mismatch: expected=${head?.toolCallId ?? "none"} actual=${toolCallId}`,
    );
  }
  session.pendingToolCalls.shift();
  state.toolCallToSessionKey.delete(toolCallId);
}

/** 현재 세션의 pending FIFO head 조회 */
export function getPendingToolCallHead(session: AgentSessionState): PendingToolCallState | undefined {
  return session.pendingToolCalls[0];
}

/** 현재 turn에서 아직 emit되지 않은 head MCP call을 emit */
export function emitNextPendingToolCall(
  session: AgentSessionState,
  emitMcpToolCall: (toolName: string, args: Record<string, unknown>, toolCallId: string) => boolean,
): boolean {
  const head = getPendingToolCallHead(session);
  if (!head || head.emitted) return false;
  const emitted = emitMcpToolCall(head.toolName, head.args, head.toolCallId);
  if (emitted) {
    head.emitted = true;
  }
  return emitted;
}

/** toolResult가 가리키는 원본 ACP 세션 조회 */
export function resolveToolResultSession(
  state: AgentProviderState,
  toolResults: Array<{ toolCallId?: string }>,
): AgentSessionState | null {
  let resolvedSession: AgentSessionState | null = null;
  for (const result of toolResults) {
    if (!result.toolCallId) {
      return null;
    }
    const sessionKey = state.toolCallToSessionKey.get(result.toolCallId);
    if (!sessionKey) {
      return null;
    }
    const session = state.sessions.get(sessionKey);
    if (!session) {
      return null;
    }
    if (!resolvedSession) {
      resolvedSession = session;
      continue;
    }
    if (resolvedSession.sessionKey !== session.sessionKey) {
      throw new Error("서로 다른 ACP 세션의 toolResult가 한 턴에 섞였습니다");
    }
  }
  return resolvedSession;
}

/** FIFO toolResult resolve — MCP HTTP 응답 반환 */
export function resolveToolResult(
  session: AgentSessionState,
  toolCallId: string,
  result: McpCallToolResult,
): void {
  if (!session.mcpSessionToken) return;
  resolveNextToolCall(session.mcpSessionToken, toolCallId, result);
}
