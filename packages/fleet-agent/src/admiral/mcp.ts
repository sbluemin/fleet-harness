import crypto from "node:crypto";

import type { McpRouterRuntime } from "@sbluemin/fleet-mcp-server";
import {
  cleanupExecutorSession,
  installExecutorToolCallRouter,
  registerExecutorSessionTools,
} from "@sbluemin/fleet-mcp-server";

export interface DedicatedMcpEndpoint {
  readonly url: string;
}

export interface DedicatedMcpSessionRequest {
  readonly label: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface DedicatedMcpSessionPort {
  getEndpoint(): Promise<DedicatedMcpEndpoint>;
  issueSessionToken(request: DedicatedMcpSessionRequest): string;
  cleanup(): void;
}

export type DedicatedMcpSessionDeps = McpRouterRuntime;

export function createDedicatedMcpSession(deps: DedicatedMcpSessionDeps): DedicatedMcpSessionPort {
  const sessionTokensByLabel = new Map<string, string>();

  return {
    async getEndpoint() {
      const url = await deps.server.start();
      return { url };
    },
    issueSessionToken(request) {
      return issueSessionToken(deps, sessionTokensByLabel, request);
    },
    cleanup() {
      for (const token of sessionTokensByLabel.values()) {
        cleanupExecutorSession(deps, token);
      }
      sessionTokensByLabel.clear();
    },
  };
}

function issueSessionToken(
  deps: DedicatedMcpSessionDeps,
  sessionTokensByLabel: Map<string, string>,
  request: DedicatedMcpSessionRequest,
): string {
  const label = request.label.trim();
  const cwd = request.cwd.trim();
  if (!label) {
    throw new Error("Dedicated MCP session label is required");
  }
  if (!cwd) {
    throw new Error("Dedicated MCP session cwd is required");
  }

  const tools = deps.registry.getAllAgentTools();
  if (tools.length === 0) {
    throw new Error("Dedicated MCP session requires a non-empty Admiral tool snapshot");
  }

  const previousToken = sessionTokensByLabel.get(label);
  if (previousToken) {
    cleanupExecutorSession(deps, previousToken);
  }

  const token = crypto.randomUUID();
  registerExecutorSessionTools(deps, token, tools);
  installExecutorToolCallRouter(deps, token, { cwd, signal: request.signal });
  sessionTokensByLabel.set(label, token);
  return token;
}
