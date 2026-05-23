import crypto from "node:crypto";

import {
  cleanupExecutorSession,
  installExecutorToolCallRouter,
  registerExecutorSessionTools,
  startMcpServer,
} from "@sbluemin/fleet-mcp-server";

import {
  getAllAgentTools,
  invoke,
} from "./agent/tools.js";

export interface DedicatedMcpEndpoint {
  readonly url: string;
}

export interface DedicatedMcpSessionRequest {
  readonly label: string;
  readonly cwd: string;
}

const dedicatedSessionTokensByLabel = new Map<string, string>();

export async function getEndpoint(): Promise<DedicatedMcpEndpoint> {
  const url = await startMcpServer();
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

  const tools = getAllAgentTools();
  if (tools.length === 0) {
    throw new Error("Dedicated MCP session requires a non-empty Admiral tool snapshot");
  }

  const previousToken = dedicatedSessionTokensByLabel.get(label);
  if (previousToken) {
    cleanupExecutorSession(previousToken);
  }

  const token = crypto.randomUUID();
  registerExecutorSessionTools(token, tools);
  installExecutorToolCallRouter(token, { cwd }, invoke);
  dedicatedSessionTokensByLabel.set(label, token);
  return token;
}

export function cleanupDedicatedMcpSessionsForRuntimeShutdown(): void {
  for (const token of dedicatedSessionTokensByLabel.values()) {
    cleanupExecutorSession(token);
  }
  dedicatedSessionTokensByLabel.clear();
}
