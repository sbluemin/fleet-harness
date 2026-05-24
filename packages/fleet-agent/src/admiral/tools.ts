import {
  buildCarrierDispatchToolSpec,
  buildCarrierJobsToolSpec,
  type CarrierRuntime,
} from "@dotobokuri/fleet-carriers";
import {
  type McpToolRegistry,
  renderAgentToolDoctrineTag,
} from "@dotobokuri/fleet-mcp-server";

import type { AgentToolSpec } from "./types.js";

export { renderAgentToolDoctrineTag };

export const CARRIER_MCP_SERVER_NAME = "fleet-carriers";
export const WIKI_MCP_SERVER_NAME = "fleet-wiki";

export const CARRIER_EXECUTOR_MCP_TOOL_IDS = ["carrier_jobs"] as const;

export const WIKI_EXECUTOR_MCP_TOOL_IDS = [
  "wiki_briefing",
  "wiki_drydock",
  "wiki_ingest",
  "wiki_orient",
  "wiki_query",
  "wiki_read",
  "wiki_resolve",
] as const;

export const EXECUTOR_MCP_TOOL_IDS = [
  ...CARRIER_EXECUTOR_MCP_TOOL_IDS,
  ...WIKI_EXECUTOR_MCP_TOOL_IDS,
] as const;

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
