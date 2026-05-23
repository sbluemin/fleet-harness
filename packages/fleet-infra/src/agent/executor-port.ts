import type { McpRouterRuntime } from "@sbluemin/fleet-mcp-server";

import type { AgentToolSpec } from "./types.js";

export interface ExecutorPort {
  getCarrierExternalMcpServerIds(carrierId?: string): readonly string[];
  getExecutorMcpTools(carrierId?: string): readonly AgentToolSpec[];
  getExecutorMcpRouterRuntime(): McpRouterRuntime;
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
    getExecutorMcpTools(carrierId) {
      return getPort().getExecutorMcpTools(carrierId);
    },
    getExecutorMcpRouterRuntime() {
      return getPort().getExecutorMcpRouterRuntime();
    },
  };
}

export const executorPortRuntime = createExecutorPortRuntime();
