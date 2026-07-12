import {
  buildCarrierJobsToolSpec,
  type CarrierRuntime,
  type CarrierToolSpecDeps,
} from "@dotobokuri/fleet-carriers";
import type { AgentToolSpec, McpToolRegistry } from "@dotobokuri/core-agent";

export const FLEET_MCP_SERVER_NAME = "fleet";

export function registerAgentToolDefaults(
  registry: McpToolRegistry,
  carrierRuntime: CarrierRuntime,
  deps: CarrierToolSpecDeps,
): void {
  // Build carrier_dispatch through the runtime so the tool owns this runtime's
  // dispatch-context registry, admission gate, and in-flight tracker.
  registry.registerAgentTool(carrierRuntime.buildDispatchToolSpec(deps));
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
