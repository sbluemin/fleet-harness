import crypto from "node:crypto";

import type { McpServer } from "./server.js";
import type { McpToolRegistry } from "./tool-registry.js";
import type { McpToolSnapshotStore } from "./tool-snapshot.js";
import type {
  AgentToolSpec,
  McpCallToolResult,
  McpProviderRoutingState,
  McpSessionRoutingState,
  McpTool,
  PendingToolCallState,
} from "./types.js";

export interface McpRouterRuntime {
  registry: McpToolRegistry;
  server: McpServer;
  snapshotStore: McpToolSnapshotStore;
}

export function installToolCallRouter<TSession extends McpSessionRoutingState>(
  runtime: McpRouterRuntime,
  state: McpProviderRoutingState<TSession>,
  session: TSession,
  onToolCallArrived?: (session: TSession, pending: PendingToolCallState) => void,
): void {
  if (!session.mcpSessionToken) return;
  runtime.server.setOnToolCallArrived(session.mcpSessionToken, (toolName, args) => {
    const pending = registerPendingToolCall(state, session, toolName, args);
    session.pendingToolCallNotifier?.();
    onToolCallArrived?.(session, pending);
    return pending.toolCallId;
  });
}

export function detachToolCallRouter(runtime: McpRouterRuntime, session: McpSessionRoutingState): void {
  if (!session.mcpSessionToken) return;
  runtime.server.setOnToolCallArrived(session.mcpSessionToken, null);
}

export function registerSessionTools(
  runtime: McpRouterRuntime,
  session: McpSessionRoutingState,
  tools: McpTool[],
): void {
  if (!session.mcpSessionToken) return;
  runtime.snapshotStore.registerToolsForSession(session.mcpSessionToken, tools);
}

export function removeSessionTools(runtime: McpRouterRuntime, session: McpSessionRoutingState): void {
  if (!session.mcpSessionToken) return;
  runtime.snapshotStore.removeToolsForSession(session.mcpSessionToken);
}

export function getSessionToolNames(runtime: McpRouterRuntime, session: McpSessionRoutingState): Set<string> {
  if (!session.mcpSessionToken) return new Set();
  return runtime.snapshotStore.getToolNamesForSession(session.mcpSessionToken);
}

export function specToMcpTool(spec: AgentToolSpec): McpTool {
  return {
    name: spec.id,
    description: spec.description,
    parameters: spec.parameters,
  };
}

export function closeLogicalPromptRouting<TSession extends McpSessionRoutingState>(
  runtime: McpRouterRuntime,
  state: McpProviderRoutingState<TSession>,
  session: TSession,
): void {
  if (session.mcpSessionToken) {
    detachToolCallRouter(runtime, session);
    runtime.server.clearPendingForSession(session.mcpSessionToken);
  }
  clearSessionRoutingState(state, session);
}

export function clearSessionRoutingState<TSession extends McpSessionRoutingState>(
  state: McpProviderRoutingState<TSession>,
  session: TSession,
): void {
  for (const pending of session.pendingToolQueue) {
    state.toolCallToSessionKey.delete(pending.toolCallId);
  }
  session.pendingToolQueue = [];
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
  session.pendingToolQueue.push(pending);
  state.toolCallToSessionKey.set(toolCallId, session.sessionKey);
  return pending;
}

export function consumePendingToolCall<TSession extends McpSessionRoutingState>(
  state: McpProviderRoutingState<TSession>,
  session: TSession,
  toolCallId: string,
): void {
  const head = session.pendingToolQueue[0];
  if (!head || head.toolCallId !== toolCallId) {
    throw new Error(
      `pending MCP head mismatch: expected=${head?.toolCallId ?? "none"} actual=${toolCallId}`,
    );
  }
  session.pendingToolQueue.shift();
  state.toolCallToSessionKey.delete(toolCallId);
}

export function getPendingToolCallHead(
  session: McpSessionRoutingState,
): PendingToolCallState | undefined {
  return session.pendingToolQueue[0];
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
  runtime: McpRouterRuntime,
  session: McpSessionRoutingState,
  toolCallId: string,
  result: McpCallToolResult,
): void {
  if (!session.mcpSessionToken) return;
  runtime.server.resolveNextToolCall(session.mcpSessionToken, toolCallId, result);
}

export function installExecutorToolCallRouter(
  runtime: McpRouterRuntime,
  sessionToken: string,
  ctx: { cwd: string; signal?: AbortSignal },
): void {
  runtime.server.setOnToolCallArrived(sessionToken, (toolName, args) => {
    const toolCallId = crypto.randomUUID();
    void runtime.registry.invoke(toolName, args, { cwd: ctx.cwd, toolCallId, signal: ctx.signal })
      .then((result) => runtime.server.resolveNextToolCall(sessionToken, toolCallId, result))
      .catch((err) => {
        runtime.server.resolveNextToolCall(sessionToken, toolCallId, {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      });
    return toolCallId;
  });
}

export function detachExecutorToolCallRouter(runtime: McpRouterRuntime, sessionToken: string): void {
  runtime.server.setOnToolCallArrived(sessionToken, null);
}

export function registerExecutorSessionTools(
  runtime: McpRouterRuntime,
  sessionToken: string,
  specs: AgentToolSpec[],
): void {
  runtime.snapshotStore.registerToolsForSession(sessionToken, specs.map(specToMcpTool));
}

export function cleanupExecutorSession(runtime: McpRouterRuntime, sessionToken: string): void {
  detachExecutorToolCallRouter(runtime, sessionToken);
  runtime.snapshotStore.removeToolsForSession(sessionToken);
  runtime.server.clearPendingForSession(sessionToken);
}

export function detachExecutorMcpForReuse(runtime: McpRouterRuntime, sessionToken: string): void {
  detachExecutorToolCallRouter(runtime, sessionToken);
  runtime.server.clearPendingForSession(sessionToken);
}
