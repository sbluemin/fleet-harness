import crypto from "node:crypto";

import {
  cleanupExecutorSession,
  installExecutorToolCallRouter,
  type McpRouterRuntime,
  registerExecutorSessionTools,
} from "./mcp-router.js";
import type { AgentToolSpec } from "./types.js";

export interface ExecutorServerEndpoint {
  readonly name: string;
  readonly url: string;
}

export interface ExecutorEndpoint {
  readonly servers: readonly ExecutorServerEndpoint[];
}

export interface ExecutorSessionRequest {
  readonly label: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface ExecutorSessionManager {
  getEndpoint(): Promise<ExecutorEndpoint>;
  issueSessionToken(request: ExecutorSessionRequest): readonly ExecutorServerToken[];
  cleanup(): void;
}

export interface ExecutorServerToken {
  readonly name: string;
  readonly token: string;
}

export interface ExecutorRuntime {
  readonly name: string;
  readonly runtime: McpRouterRuntime;
}

export interface ExecutorSessionManagerDeps {
  readonly runtimes: readonly ExecutorRuntime[];
}

export function createExecutorSessionManager(deps: ExecutorSessionManagerDeps): ExecutorSessionManager {
  const sessionTokensByLabel = new Map<string, readonly ExecutorServerToken[]>();

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
        cleanupExecutorServerTokens(deps, tokens);
      }
      sessionTokensByLabel.clear();
    },
  };
}

function issueSessionToken(
  deps: ExecutorSessionManagerDeps,
  sessionTokensByLabel: Map<string, readonly ExecutorServerToken[]>,
  request: ExecutorSessionRequest,
): readonly ExecutorServerToken[] {
  const label = request.label.trim();
  const cwd = request.cwd.trim();
  if (!label) {
    throw new Error("Executor session label is required");
  }
  if (!cwd) {
    throw new Error("Executor session cwd is required");
  }

  const previousTokens = sessionTokensByLabel.get(label);
  if (previousTokens) {
    cleanupExecutorServerTokens(deps, previousTokens);
  }

  const tokens: ExecutorServerToken[] = [];
  try {
    for (const { name, runtime } of deps.runtimes) {
      const tools = runtime.registry.getAllAgentTools();
      assertNonEmptyExecutorTools(name, tools);
      const token = crypto.randomUUID();
      registerExecutorSessionTools(runtime, token, tools);
      installExecutorToolCallRouter(runtime, token, { cwd, signal: request.signal });
      tokens.push({ name, token });
    }
  } catch (error) {
    cleanupExecutorServerTokens(deps, tokens);
    throw error;
  }

  sessionTokensByLabel.set(label, tokens);
  return tokens;
}

function cleanupExecutorServerTokens(
  deps: ExecutorSessionManagerDeps,
  tokens: readonly ExecutorServerToken[],
): void {
  for (const { name, token } of tokens) {
    const runtime = deps.runtimes.find((entry) => entry.name === name)?.runtime;
    if (runtime) cleanupExecutorSession(runtime, token);
  }
}

function assertNonEmptyExecutorTools(
  serverName: string,
  tools: readonly AgentToolSpec[],
): void {
  if (tools.length === 0) {
    throw new Error(`Executor session requires a non-empty tool snapshot for ${serverName}`);
  }
}
