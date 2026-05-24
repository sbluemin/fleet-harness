import crypto from "node:crypto";

import type { AgentToolSpec, McpRouterRuntime } from "@dotobokuri/fleet-mcp-server";
import {
  cleanupExecutorSession,
  installExecutorToolCallRouter,
  registerExecutorSessionTools,
} from "@dotobokuri/fleet-mcp-server";

export interface DedicatedMcpServerEndpoint {
  readonly name: string;
  readonly url: string;
}

export interface DedicatedMcpEndpoint {
  readonly servers: readonly DedicatedMcpServerEndpoint[];
}

export interface DedicatedMcpSessionRequest {
  readonly label: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface DedicatedMcpSessionPort {
  getEndpoint(): Promise<DedicatedMcpEndpoint>;
  issueSessionToken(request: DedicatedMcpSessionRequest): readonly DedicatedMcpServerToken[];
  cleanup(): void;
}

export interface DedicatedMcpServerToken {
  readonly name: string;
  readonly token: string;
}

export interface DedicatedMcpRuntime {
  readonly name: string;
  readonly runtime: McpRouterRuntime;
}

export interface DedicatedMcpSessionDeps {
  readonly runtimes: readonly DedicatedMcpRuntime[];
}

export function createDedicatedMcpSession(deps: DedicatedMcpSessionDeps): DedicatedMcpSessionPort {
  const sessionTokensByLabel = new Map<string, readonly DedicatedMcpServerToken[]>();

  return {
    async getEndpoint() {
      const servers = await Promise.all(
        deps.runtimes.map(async ({ name, runtime }) => ({
          name,
          url: await runtime.server.start(),
        })),
      );
      return { servers };
    },
    issueSessionToken(request) {
      return issueSessionToken(deps, sessionTokensByLabel, request);
    },
    cleanup() {
      for (const tokens of sessionTokensByLabel.values()) {
        cleanupDedicatedMcpServerTokens(deps, tokens);
      }
      sessionTokensByLabel.clear();
    },
  };
}

function issueSessionToken(
  deps: DedicatedMcpSessionDeps,
  sessionTokensByLabel: Map<string, readonly DedicatedMcpServerToken[]>,
  request: DedicatedMcpSessionRequest,
): readonly DedicatedMcpServerToken[] {
  const label = request.label.trim();
  const cwd = request.cwd.trim();
  if (!label) {
    throw new Error("Dedicated MCP session label is required");
  }
  if (!cwd) {
    throw new Error("Dedicated MCP session cwd is required");
  }

  const previousTokens = sessionTokensByLabel.get(label);
  if (previousTokens) {
    cleanupDedicatedMcpServerTokens(deps, previousTokens);
  }

  const tokens: DedicatedMcpServerToken[] = [];
  try {
    for (const { name, runtime } of deps.runtimes) {
      const tools = runtime.registry.getAllAgentTools();
      assertNonEmptyDedicatedTools(name, tools);
      const token = crypto.randomUUID();
      registerExecutorSessionTools(runtime, token, tools);
      installExecutorToolCallRouter(runtime, token, { cwd, signal: request.signal });
      tokens.push({ name, token });
    }
  } catch (error) {
    cleanupDedicatedMcpServerTokens(deps, tokens);
    throw error;
  }

  sessionTokensByLabel.set(label, tokens);
  return tokens;
}

function cleanupDedicatedMcpServerTokens(
  deps: DedicatedMcpSessionDeps,
  tokens: readonly DedicatedMcpServerToken[],
): void {
  for (const { name, token } of tokens) {
    const runtime = deps.runtimes.find((entry) => entry.name === name)?.runtime;
    if (runtime) cleanupExecutorSession(runtime, token);
  }
}

function assertNonEmptyDedicatedTools(
  serverName: string,
  tools: readonly AgentToolSpec[],
): void {
  if (tools.length === 0) {
    throw new Error(`Dedicated MCP session requires a non-empty tool snapshot for ${serverName}`);
  }
}
