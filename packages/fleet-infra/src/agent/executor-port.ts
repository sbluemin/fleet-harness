import type { AgentToolSpec } from "./types.js";

export interface ExecutorPort {
  getCarrierExternalMcpServerIds(carrierId?: string): readonly string[];
  getExecutorMcpTools(carrierId?: string): readonly AgentToolSpec[];
}

let executorPort: ExecutorPort | undefined;

export function registerExecutorPort(port: ExecutorPort): void {
  executorPort = port;
}

export function getExecutorPort(): ExecutorPort {
  if (!executorPort) {
    throw new Error("Fleet agent executor port is not registered. Boot the fleet-agent Composition Root before executor use.");
  }

  return executorPort;
}

export function getCarrierExternalMcpServerIds(carrierId?: string): readonly string[] {
  return getExecutorPort().getCarrierExternalMcpServerIds(carrierId);
}

export function getExecutorMcpTools(carrierId?: string): readonly AgentToolSpec[] {
  return getExecutorPort().getExecutorMcpTools(carrierId);
}
