import crypto from "node:crypto";

import type { McpServerConfig } from "../types.js";

import {
  cleanupExecutorSession,
  installExecutorToolCallRouter,
  type McpRouterRuntime,
  registerExecutorSessionTools,
} from "./router.js";
import type { AgentToolSpec } from "../../tools/spec.js";

export interface ExecutorMcpRouterRuntime {
  readonly name: string;
  readonly runtime: McpRouterRuntime;
}

export interface ExecutorPort {
  getScopeExternalMcpServerIds(scopeId?: string): readonly string[];
  getExecutorMcpTools(serverName: string, scopeId?: string): readonly AgentToolSpec[];
}

export interface ExecutorPortRuntime extends ExecutorPort {
  register(port: ExecutorPort): void;
  getPort(): ExecutorPort;
}

export interface ExecutorMcpRuntimeProvider {
  getExecutorMcpRouterRuntimes(): readonly ExecutorMcpRouterRuntime[];
  createExecutorMcpSession?(request: ExecutorMcpSessionRequest): Promise<ExecutorMcpSession>;
}

export interface ExecutorMcpSessionRequest {
  readonly serverName: string;
  readonly specs: readonly AgentToolSpec[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface ExecutorMcpSession {
  readonly serverName: string;
  readonly token: string;
  readonly mcpServer: McpServerConfig;
  cleanup(): void;
}

export interface ExecutorMcpRuntimeProviderRuntime extends ExecutorMcpRuntimeProvider {
  register(provider: ExecutorMcpRuntimeProvider): void;
  getProvider(): ExecutorMcpRuntimeProvider;
}

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
  /**
   * Narrows which registered agent tools this host session may call.
   * Omit to expose every registered agent tool.
   */
  readonly includeTool?: (toolId: string) => boolean;
}

export interface ExecutorServerToken {
  readonly name: string;
  readonly token: string;
}

export type CoreExecutorMcpSession = ExecutorMcpSession;
export type CoreExecutorMcpSessionRequest = ExecutorMcpSessionRequest;

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
}

const DEFAULT_TOOL_TIMEOUT_SECONDS = 1800;

export function createExecutorPortRuntime(): ExecutorPortRuntime {
  let portRef: ExecutorPort | undefined;

  function getPort(): ExecutorPort {
    if (!portRef) {
      throw new Error("Agent executor port is not registered. Register an executor policy port before executor use.");
    }

    return portRef;
  }

  return {
    register(port) {
      portRef = port;
    },
    getPort,
    getScopeExternalMcpServerIds(scopeId) {
      return getPort().getScopeExternalMcpServerIds(scopeId);
    },
    getExecutorMcpTools(serverName, scopeId) {
      return getPort().getExecutorMcpTools(serverName, scopeId);
    },
  };
}

export function createExecutorMcpRuntimeProviderRuntime(): ExecutorMcpRuntimeProviderRuntime {
  let providerRef: ExecutorMcpRuntimeProvider | undefined;

  function getProvider(): ExecutorMcpRuntimeProvider {
    if (!providerRef) {
      throw new Error("Agent executor MCP runtime provider is not registered. Register executor MCP runtimes before executor use.");
    }

    return providerRef;
  }

  return {
    register(provider) {
      providerRef = provider;
    },
    getProvider,
    getExecutorMcpRouterRuntimes() {
      return getProvider().getExecutorMcpRouterRuntimes();
    },
  };
}

// fleet-admiral과 core-agent executor engine 사이의 등록 채널이다.
export const executorPortRuntime = createExecutorPortRuntime();
export const executorMcpRuntimeProviderRuntime = createExecutorMcpRuntimeProviderRuntime();

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
  registerExecutorSessionTools(runtime.runtime, token, [...request.specs]);
  installExecutorToolCallRouter(runtime.runtime, token, {
    cwd,
    signal: request.signal,
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
  try {
    for (const { name, runtime } of deps.runtimes) {
      const allTools = runtime.registry.getAllAgentTools();
      const tools = request.includeTool
        ? allTools.filter((tool) => request.includeTool?.(tool.id) ?? true)
        : allTools;
      assertNonEmptyExecutorTools(name, tools);
      const token = crypto.randomUUID();
      registerExecutorSessionTools(runtime, token, tools);
      installExecutorToolCallRouter(runtime, token, {
        cwd,
        sessionLabel: label,
        signal: request.signal,
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
    toolTimeoutSeconds,
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
