import {
  buildCarrierDispatchToolSpec,
  buildCarrierJobsToolSpec,
  type CarrierRuntime,
  type CarrierToolSpecDeps,
} from "@dotobokuri/fleet-carriers";
import type { AgentToolSpec, McpToolRegistry } from "@dotobokuri/core-mcp-server";

export const FLEET_MCP_SERVER_NAME = "fleet";

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

export function registerAgentToolDefaults(
  registry: McpToolRegistry,
  carrierRuntime: CarrierRuntime,
  deps: CarrierToolSpecDeps,
): void {
  registry.registerAgentTool(buildCarrierDispatchToolSpec(carrierRuntime.registry, deps));
  registry.registerAgentTool(buildCarrierJobsToolSpec());
}

export function getExecutorMcpTools(
  registry: McpToolRegistry,
  carrierRuntime: CarrierRuntime,
  carrierId?: string,
): AgentToolSpec[] {
  const metadataIds = carrierId
    ? carrierRuntime.registry.getState().modes.get(carrierId)?.config.carrierMetadata?.allowedExecutorTools ?? []
    : [];
  return registry.getExecutorMcpToolsForScope(carrierId, metadataIds);
}

export function renderFleetToolGuide(tool: AgentToolSpec, markdown: string): string {
  return `<fleet section="tool-guide" tool="${tool.tag}">\n${markdown}\n</fleet>`;
}
