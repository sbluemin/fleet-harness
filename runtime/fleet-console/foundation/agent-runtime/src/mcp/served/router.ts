import crypto from "node:crypto";

import type { McpToolRegistry } from "../../tools/registry.js";
import type { McpToolSnapshotStore } from "../../tools/snapshot.js";
import type { AgentToolSpec, McpCallToolResult, McpTool } from "../../tools/spec.js";
import type { ToolCallArrivedCallback } from "./jsonrpc.js";

export type { ToolCallArrivedCallback } from "./jsonrpc.js";

export interface McpRouterServer {
  start(): Promise<string>;
  setOnToolCallArrived(token: string, cb: ToolCallArrivedCallback | null): void;
  resolveToolCall(token: string, toolCallId: string, result: McpCallToolResult): void;
  clearPendingForSession(token: string): void;
}

export interface McpRouterRuntime {
  readonly resources?: readonly import("../resources.js").McpResource[];
  registry: McpToolRegistry;
  server: McpRouterServer;
  snapshotStore: McpToolSnapshotStore;
  onFailure?: (kind: string, error: unknown) => void;
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
  ctx: { cwd: string; sessionLabel?: string; signal?: AbortSignal },
): void {
  runtime.server.setOnToolCallArrived(sessionToken, (toolName, args) => {
    const toolCallId = crypto.randomUUID();
    void runtime.registry.invoke(toolName, args, {
      cwd: ctx.cwd,
      sessionLabel: ctx.sessionLabel,
      toolCallId,
      signal: ctx.signal,
    })
      .then((result) => runtime.server.resolveToolCall(sessionToken, toolCallId, result), (err) => {
        runtime.server.resolveToolCall(sessionToken, toolCallId, {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      })
      .catch((error: unknown) => {
        // Tool effects may already have happened; do not retry the call or claim an execution failure.
        try {
          if (runtime.onFailure) runtime.onFailure("mcp_result_delivery_failed", error);
          else process.stderr.write(`[fleet-mcp] tool result delivery failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        }
        catch { /* Logging cannot reject another detached Promise. */ }
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
