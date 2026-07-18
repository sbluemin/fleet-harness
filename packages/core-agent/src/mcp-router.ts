import crypto from "node:crypto";

import type { McpToolRegistry } from "./tool-registry.js";
import type { McpToolSnapshotStore } from "./tool-snapshot.js";
import type { AgentServerBindings, AgentToolSpec, McpCallToolResult, McpTool } from "./types.js";

export type ToolCallArrivedCallback = (
  toolName: string,
  args: Record<string, unknown>,
) => string;

export interface McpRouterServer {
  start(): Promise<string>;
  setOnToolCallArrived(token: string, cb: ToolCallArrivedCallback | null): void;
  resolveNextToolCall(token: string, toolCallId: string, result: McpCallToolResult): void;
  clearPendingForSession(token: string): void;
}

export interface McpRouterRuntime {
  registry: McpToolRegistry;
  server: McpRouterServer;
  snapshotStore: McpToolSnapshotStore;
}

export function specToMcpTool(spec: AgentToolSpec): McpTool {
  return {
    name: spec.id,
    description: spec.description,
    parameters: spec.parameters,
  };
}

export function installExecutorToolCallRouter(
  runtime: McpRouterRuntime,
  sessionToken: string,
  ctx: { cwd: string; sessionLabel?: string; signal?: AbortSignal; serverBindings?: AgentServerBindings },
): void {
  runtime.server.setOnToolCallArrived(sessionToken, (toolName, args) => {
    const toolCallId = crypto.randomUUID();
    void runtime.registry.invoke(toolName, args, {
      cwd: ctx.cwd,
      sessionLabel: ctx.sessionLabel,
      toolCallId,
      signal: ctx.signal,
      serverBindings: ctx.serverBindings,
    })
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

export function registerExecutorSessionTools(
  runtime: McpRouterRuntime,
  sessionToken: string,
  specs: AgentToolSpec[],
): void {
  runtime.snapshotStore.registerToolsForSession(sessionToken, specs.map(specToMcpTool));
}

export function cleanupExecutorSession(runtime: McpRouterRuntime, sessionToken: string): void {
  runtime.server.setOnToolCallArrived(sessionToken, null);
  runtime.snapshotStore.removeToolsForSession(sessionToken);
  runtime.server.clearPendingForSession(sessionToken);
}
