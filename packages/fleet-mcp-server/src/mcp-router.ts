import crypto from "node:crypto";

import {
  clearPendingForSession,
  resolveNextToolCall,
  setOnToolCallArrived,
} from "./server.js";
import {
  getToolNamesForSession,
  registerToolsForSession,
  removeToolsForSession,
} from "./tool-snapshot.js";
import type {
  AgentToolCtx,
  AgentToolSpec,
  McpCallToolResult,
  McpProviderRoutingState,
  McpSessionRoutingState,
  McpTool,
  PendingToolCallState,
} from "./types.js";

export function installToolCallRouter<TSession extends McpSessionRoutingState>(
  state: McpProviderRoutingState<TSession>,
  session: TSession,
  onToolCallArrived?: (session: TSession, pending: PendingToolCallState) => void,
): void {
  if (!session.mcpSessionToken) return;
  setOnToolCallArrived(session.mcpSessionToken, (toolName, args) => {
    const pending = registerPendingToolCall(state, session, toolName, args);
    session.pendingToolCallNotifier?.();
    onToolCallArrived?.(session, pending);
    return pending.toolCallId;
  });
}

export function detachToolCallRouter(session: McpSessionRoutingState): void {
  if (!session.mcpSessionToken) return;
  setOnToolCallArrived(session.mcpSessionToken, null);
}

export function registerSessionTools(
  session: McpSessionRoutingState,
  tools: McpTool[],
): void {
  if (!session.mcpSessionToken) return;
  registerToolsForSession(session.mcpSessionToken, tools);
}

export function removeSessionTools(session: McpSessionRoutingState): void {
  if (!session.mcpSessionToken) return;
  removeToolsForSession(session.mcpSessionToken);
}

export function getSessionToolNames(session: McpSessionRoutingState): Set<string> {
  if (!session.mcpSessionToken) return new Set();
  return getToolNamesForSession(session.mcpSessionToken);
}

export function specToMcpTool(spec: AgentToolSpec): McpTool {
  return {
    name: spec.id,
    description: spec.description,
    parameters: spec.parameters,
  };
}

export function closeLogicalPromptRouting<TSession extends McpSessionRoutingState>(
  state: McpProviderRoutingState<TSession>,
  session: TSession,
): void {
  if (session.mcpSessionToken) {
    detachToolCallRouter(session);
    clearPendingForSession(session.mcpSessionToken);
  }
  clearSessionRoutingState(state, session);
}

export function clearSessionRoutingState<TSession extends McpSessionRoutingState>(
  state: McpProviderRoutingState<TSession>,
  session: TSession,
): void {
  for (const pending of session.pendingToolCalls) {
    state.toolCallToSessionKey.delete(pending.toolCallId);
  }
  session.pendingToolCalls = [];
  session.pendingToolCallNotifier = null;
}

export function registerPendingToolCall<TSession extends McpSessionRoutingState>(
  state: McpProviderRoutingState<TSession>,
  session: TSession,
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

export function consumePendingToolCall<TSession extends McpSessionRoutingState>(
  state: McpProviderRoutingState<TSession>,
  session: TSession,
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

export function getPendingToolCallHead(
  session: McpSessionRoutingState,
): PendingToolCallState | undefined {
  return session.pendingToolCalls[0];
}

export function emitNextPendingToolCall(
  session: McpSessionRoutingState,
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

export function resolveToolResultSession<TSession extends McpSessionRoutingState>(
  state: McpProviderRoutingState<TSession>,
  toolResults: Array<{ toolCallId?: string }>,
): TSession | null {
  let resolvedSession: TSession | null = null;
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

export function resolveToolResult(
  session: McpSessionRoutingState,
  toolCallId: string,
  result: McpCallToolResult,
): void {
  if (!session.mcpSessionToken) return;
  resolveNextToolCall(session.mcpSessionToken, toolCallId, result);
}

export function installExecutorToolCallRouter(
  sessionToken: string,
  ctx: { cwd: string; signal?: AbortSignal },
  invokeTool: (
    name: string,
    args: unknown,
    ctx?: Partial<AgentToolCtx>,
  ) => Promise<McpCallToolResult>,
): void {
  setOnToolCallArrived(sessionToken, (toolName, args) => {
    const toolCallId = crypto.randomUUID();
    void invokeTool(toolName, args, { cwd: ctx.cwd, toolCallId, signal: ctx.signal })
      .then((result) => resolveNextToolCall(sessionToken, toolCallId, result))
      .catch((err) => {
        resolveNextToolCall(sessionToken, toolCallId, {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      });
    return toolCallId;
  });
}

export function detachExecutorToolCallRouter(sessionToken: string): void {
  setOnToolCallArrived(sessionToken, null);
}

export function registerExecutorSessionTools(
  sessionToken: string,
  specs: AgentToolSpec[],
): void {
  registerToolsForSession(sessionToken, specs.map(specToMcpTool));
}

export function cleanupExecutorSession(sessionToken: string): void {
  detachExecutorToolCallRouter(sessionToken);
  removeToolsForSession(sessionToken);
  clearPendingForSession(sessionToken);
}

export function detachExecutorMcpForReuse(sessionToken: string): void {
  detachExecutorToolCallRouter(sessionToken);
  clearPendingForSession(sessionToken);
}
