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

export {
  EXECUTOR_MCP_TOOL_IDS,
  renderAgentToolDoctrineTag,
};

export function registerAgentToolDefaults(registry: McpToolRegistry, carrierRuntime: CarrierRuntime): void {
  registry.registerAgentTool(buildCarrierDispatchToolSpec(carrierRuntime.registry));
  registry.registerAgentTool(buildCarrierJobsToolSpec());
}

export function getAllAgentTools(registry: McpToolRegistry): AgentToolSpec[] {
  return registry.getAllAgentTools();
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
