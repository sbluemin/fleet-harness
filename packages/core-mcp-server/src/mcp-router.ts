import crypto from "node:crypto";

import type { McpServer } from "./server.js";
import type { McpToolRegistry } from "./tool-registry.js";
import type { McpToolSnapshotStore } from "./tool-snapshot.js";
import type { AgentToolSpec, McpTool } from "./types.js";

export interface McpRouterRuntime {
  registry: McpToolRegistry;
  server: McpServer;
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
