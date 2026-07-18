import crypto from "node:crypto";

import type { McpServerConfig } from "@dotobokuri/core-unified-agent";

import {
  cleanupExecutorSession,
  installExecutorToolCallRouter,
  type McpRouterRuntime,
  registerExecutorSessionTools,
} from "./mcp-router.js";
import { snapshotAgentServerBindings, type AgentServerBindings, type AgentToolSpec } from "./types.js";

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
  readonly serverBindings?: AgentServerBindings;
}

export interface ExecutorServerToken {
  readonly name: string;
  readonly token: string;
}

export interface CoreExecutorMcpSession {
  readonly serverName: string;
  readonly token: string;
  readonly mcpServer: McpServerConfig;
  cleanup(): void;
}

export interface CoreExecutorMcpSessionRequest {
  readonly serverName: string;
  readonly specs: readonly AgentToolSpec[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly serverBindings?: AgentServerBindings;
}

export interface ExecutorSessionManager {
  getEndpoint(): Promise<ExecutorEndpoint>;
  issueSessionToken(request: ExecutorSessionRequest): readonly ExecutorServerToken[];
  createExecutorMcpSession(request: CoreExecutorMcpSessionRequest): Promise<CoreExecutorMcpSession>;
  releaseSessionToken(label: string): void;
  cleanup(): void;
}

export interface ExecutorRuntime {
  readonly name: string;
  readonly runtime: McpRouterRuntime;
}

export interface CreateExecutorSessionManagerDeps {
  readonly runtimes: readonly ExecutorRuntime[];
  readonly toolTimeoutSeconds?: number;
}

interface ActiveSession {
  readonly tokens: readonly ExecutorServerToken[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly serverBindings?: AgentServerBindings;
}

const DEFAULT_TOOL_TIMEOUT_SECONDS = 1800;

export function createExecutorSessionManager(deps: CreateExecutorSessionManagerDeps): ExecutorSessionManager {
  const sessionTokensByLabel = new Map<string, ActiveSession>();
  const toolTimeoutSeconds = deps.toolTimeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS;

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
    async createExecutorMcpSession(request) {
      return createExecutorMcpSession(deps, toolTimeoutSeconds, request);
    },
    releaseSessionToken(label) {
      releaseSessionToken(deps, sessionTokensByLabel, label);
    },
    cleanup() {
      for (const session of sessionTokensByLabel.values()) {
        cleanupExecutorServerTokens(deps, session.tokens);
      }
      sessionTokensByLabel.clear();
    },
  };
}

function createExecutorMcpSession(
  deps: CreateExecutorSessionManagerDeps,
  toolTimeoutSeconds: number,
  request: CoreExecutorMcpSessionRequest,
): Promise<CoreExecutorMcpSession> {
  const runtime = findRuntime(deps, request.serverName);
  const cwd = request.cwd.trim();
  if (!cwd) {
    throw new Error("Executor session cwd is required");
  }
  assertNonEmptyExecutorTools(request.serverName, request.specs);

  const token = crypto.randomUUID();
  const serverBindings = snapshotAgentServerBindings(request.serverBindings);
  registerExecutorSessionTools(runtime.runtime, token, [...request.specs]);
  installExecutorToolCallRouter(runtime.runtime, token, {
    cwd,
    signal: request.signal,
    serverBindings,
  });

  return runtime.runtime.server.start().then((url) => ({
    serverName: request.serverName,
    token,
    mcpServer: buildMcpServerConfig(request.serverName, url, token, toolTimeoutSeconds),
    cleanup: () => cleanupExecutorSession(runtime.runtime, token),
  }));
}

function releaseSessionToken(
  deps: CreateExecutorSessionManagerDeps,
  sessionTokensByLabel: Map<string, ActiveSession>,
  rawLabel: string,
): void {
  const label = rawLabel.trim();
  const session = sessionTokensByLabel.get(label);
  if (!session) return;
  cleanupExecutorServerTokens(deps, session.tokens);
  sessionTokensByLabel.delete(label);
}

function issueSessionToken(
  deps: CreateExecutorSessionManagerDeps,
  sessionTokensByLabel: Map<string, ActiveSession>,
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

  const previous = sessionTokensByLabel.get(label);
  if (previous) {
    cleanupExecutorServerTokens(deps, previous.tokens);
  }

  const tokens: ExecutorServerToken[] = [];
  const serverBindings = snapshotAgentServerBindings(request.serverBindings);
  try {
    for (const { name, runtime } of deps.runtimes) {
      const tools = runtime.registry.getAllAgentTools();
      assertNonEmptyExecutorTools(name, tools);
      const token = crypto.randomUUID();
      registerExecutorSessionTools(runtime, token, tools);
      installExecutorToolCallRouter(runtime, token, {
        cwd,
        sessionLabel: label,
        signal: request.signal,
        serverBindings,
      });
      tokens.push({ name, token });
    }
  } catch (error) {
    cleanupExecutorServerTokens(deps, tokens);
    throw error;
  }

  sessionTokensByLabel.set(label, {
    tokens,
    cwd,
    signal: request.signal,
    serverBindings,
  });
  return tokens;
}

function cleanupExecutorServerTokens(
  deps: CreateExecutorSessionManagerDeps,
  tokens: readonly ExecutorServerToken[],
): void {
  for (const { name, token } of tokens) {
    const runtime = deps.runtimes.find((entry) => entry.name === name)?.runtime;
    if (runtime) cleanupExecutorSession(runtime, token);
  }
}

function findRuntime(deps: CreateExecutorSessionManagerDeps, serverName: string): ExecutorRuntime {
  const runtime = deps.runtimes.find((entry) => entry.name === serverName);
  if (!runtime) {
    throw new Error(`Executor MCP runtime not found: ${serverName}`);
  }
  return runtime;
}

function buildMcpServerConfig(
  name: string,
  url: string,
  token: string,
  toolTimeoutSeconds: number,
): McpServerConfig {
  return {
    type: "http",
    name,
    url,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    toolTimeout: toolTimeoutSeconds,
  };
}

function assertNonEmptyExecutorTools(
  serverName: string,
  tools: readonly AgentToolSpec[],
): void {
  if (tools.length === 0) {
    throw new Error(`Executor session requires a non-empty tool snapshot for ${serverName}`);
  }
}
