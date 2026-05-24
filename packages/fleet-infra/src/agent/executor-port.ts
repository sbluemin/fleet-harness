import type { McpRouterRuntime } from "@dotobokuri/fleet-mcp-server";

import type { AgentToolSpec } from "./types.js";

export interface ExecutorMcpRouterRuntime {
  readonly name: string;
  readonly runtime: McpRouterRuntime;
}

export interface ExecutorPort {
  getCarrierExternalMcpServerIds(carrierId?: string): readonly string[];
  getExecutorMcpTools(serverName: string, carrierId?: string): readonly AgentToolSpec[];
  getExecutorMcpRouterRuntimes(): readonly ExecutorMcpRouterRuntime[];
}

export interface ExecutorPortRuntime extends ExecutorPort {
  register(port: ExecutorPort): void;
  getPort(): ExecutorPort;
}

export function createExecutorPortRuntime(): ExecutorPortRuntime {
  let portRef: ExecutorPort | undefined;

  function getPort(): ExecutorPort {
    if (!portRef) {
      throw new Error("Fleet agent executor port is not registered. Boot the fleet-agent Composition Root before executor use.");
    }

    return portRef;
  }

  return {
    register(port) {
      portRef = port;
    },
    getPort,
    getCarrierExternalMcpServerIds(carrierId) {
      return getPort().getCarrierExternalMcpServerIds(carrierId);
    },
    getExecutorMcpTools(serverName, carrierId) {
      return getPort().getExecutorMcpTools(serverName, carrierId);
    },
    getExecutorMcpRouterRuntimes() {
      return getPort().getExecutorMcpRouterRuntimes();
    },
  };
}

export const executorPortRuntime = createExecutorPortRuntime();
