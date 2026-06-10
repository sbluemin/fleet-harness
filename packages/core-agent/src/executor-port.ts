import type { ExecutorRuntime } from "@dotobokuri/core-mcp-server";

import type { AgentToolSpec } from "./types.js";

// 구조 동일 타입의 SSoT는 core-mcp-server의 ExecutorRuntime — 기존 공개 이름은 별칭으로 유지한다.
export type ExecutorMcpRouterRuntime = ExecutorRuntime;

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
