import crypto from "node:crypto";

import type {
  AgentToolCtx,
  McpCallToolResult,
  McpServer,
  McpToolRegistry,
  McpToolSnapshotStore,
} from "@sbluemin/fleet-mcp-server";
import { specToMcpTool } from "@sbluemin/fleet-mcp-server";

export interface DedicatedMcpEndpoint {
  readonly url: string;
}

export interface DedicatedMcpSessionRequest {
  readonly label: string;
  readonly cwd: string;
}

interface DedicatedMcpRuntime {
  readonly server: McpServer;
  readonly registry: McpToolRegistry;
  readonly snapshotStore: McpToolSnapshotStore;
}

const dedicatedSessionTokensByLabel = new Map<string, string>();
let dedicatedRuntime: DedicatedMcpRuntime | null = null;

export function configureDedicatedMcpRuntime(runtime: DedicatedMcpRuntime): void {
  dedicatedRuntime = runtime;
}

export async function getEndpoint(): Promise<DedicatedMcpEndpoint> {
  const url = await requireDedicatedRuntime().server.start();
  return { url };
}

export function issueDedicatedSessionToken(request: DedicatedMcpSessionRequest): string {
  const label = request.label.trim();
  const cwd = request.cwd.trim();
  if (!label) {
    throw new Error("Dedicated MCP session label is required");
  }
  if (!cwd) {
    throw new Error("Dedicated MCP session cwd is required");
  }

  const runtime = requireDedicatedRuntime();
  const tools = runtime.registry.getAllAgentTools();
  if (tools.length === 0) {
    throw new Error("Dedicated MCP session requires a non-empty Admiral tool snapshot");
  }

  const previousToken = dedicatedSessionTokensByLabel.get(label);
  if (previousToken) {
    cleanupExecutorSession(runtime, previousToken);
  }

  const token = crypto.randomUUID();
  runtime.snapshotStore.registerToolsForSession(token, tools.map(specToMcpTool));
  runtime.server.setOnToolCallArrived(token, (toolName, args) => {
    const toolCallId = crypto.randomUUID();
    void invokeTool(runtime.registry, toolName, args, { cwd, toolCallId })
      .then((result) => runtime.server.resolveNextToolCall(token, toolCallId, result))
      .catch((err) => {
        runtime.server.resolveNextToolCall(token, toolCallId, {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      });
    return toolCallId;
  });
  dedicatedSessionTokensByLabel.set(label, token);
  return token;
}

export function cleanupDedicatedMcpRuntime(): void {
  const runtime = dedicatedRuntime;
  for (const token of dedicatedSessionTokensByLabel.values()) {
    if (runtime) {
      cleanupExecutorSession(runtime, token);
    }
  }
  dedicatedSessionTokensByLabel.clear();
  dedicatedRuntime = null;
}

function requireDedicatedRuntime(): DedicatedMcpRuntime {
  if (!dedicatedRuntime) {
    throw new Error("Dedicated MCP runtime is not configured. Boot the fleet-agent Composition Root first.");
  }
  return dedicatedRuntime;
}

function cleanupExecutorSession(runtime: DedicatedMcpRuntime, sessionToken: string): void {
  runtime.server.setOnToolCallArrived(sessionToken, null);
  runtime.snapshotStore.removeToolsForSession(sessionToken);
  runtime.server.clearPendingForSession(sessionToken);
}

async function invokeTool(
  registry: McpToolRegistry,
  name: string,
  args: unknown,
  ctx?: Partial<AgentToolCtx>,
): Promise<McpCallToolResult> {
  return registry.invoke(name, args, ctx);
}
