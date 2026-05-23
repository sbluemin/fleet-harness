import {
  buildCarrierDispatchToolSpec,
  buildCarrierJobsToolSpec,
  type CarrierRuntime,
} from "@sbluemin/fleet-carriers";
import {
  EXECUTOR_MCP_TOOL_IDS,
  type McpToolRegistry,
  renderAgentToolDoctrineTag,
} from "@sbluemin/fleet-mcp-server";

import type { AgentToolSpec } from "./types.js";

let activeToolRegistry: McpToolRegistry | null = null;

export {
  EXECUTOR_MCP_TOOL_IDS,
  renderAgentToolDoctrineTag,
};

export function configureAgentToolRegistry(registry: McpToolRegistry): void {
  activeToolRegistry = registry;
}

export function registerAgentToolDefaults(registry: McpToolRegistry, carrierRuntime: CarrierRuntime): void {
  registry.registerAgentTool(buildCarrierDispatchToolSpec(carrierRuntime.registry));
  registry.registerAgentTool(buildCarrierJobsToolSpec());
}

export function getAllAgentTools(): AgentToolSpec[] {
  return requireActiveToolRegistry().getAllAgentTools();
}

export function getExecutorMcpTools(
  registry: McpToolRegistry,
  carrierRuntime: CarrierRuntime,
  carrierId?: string,
): AgentToolSpec[] {
  const metadataIds = carrierId
    ? carrierRuntime.registry.getState().modes.get(carrierId)?.config.carrierMetadata?.allowedExecutorTools ?? []
    : [];
  return registry.getExecutorMcpToolsForCarrier(carrierId, metadataIds);
}

export function clearAllDefaultTools(registry: McpToolRegistry): void {
  registry.clearAllDefaultTools();
}

function requireActiveToolRegistry(): McpToolRegistry {
  if (!activeToolRegistry) {
    throw new Error("Admiral tool registry is not configured");
  }
  return activeToolRegistry;
}
