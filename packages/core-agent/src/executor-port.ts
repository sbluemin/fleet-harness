import type { McpServerConfig } from "@dotobokuri/core-unified-agent";

import type { McpRouterRuntime } from "./mcp-router.js";
import type { AgentServerBindings, AgentToolSpec } from "./types.js";

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
  readonly serverBindings?: AgentServerBindings;
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

export const executorPortRuntime = createExecutorPortRuntime();
export const executorMcpRuntimeProviderRuntime = createExecutorMcpRuntimeProviderRuntime();
