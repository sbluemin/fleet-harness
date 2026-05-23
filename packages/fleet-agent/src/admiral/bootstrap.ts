import type { McpToolRegistry } from "@sbluemin/fleet-mcp-server";

import { buildCarrierDispatchToolSpec, buildCarrierJobsToolSpec, type CarrierRuntime } from "@sbluemin/fleet-carriers";
import type { AgentToolSpec } from "./types.js";

const registeredDefaultToolIds = new Set<string>();

export function registerAgentToolDefaults(registry: McpToolRegistry, carrierRuntime: CarrierRuntime): void {
  registerDefaultTool(registry, buildCarrierDispatchToolSpec(carrierRuntime.registry));
  registerDefaultTool(registry, buildCarrierJobsToolSpec());
}

export function resetDefaultAgentToolsRegistration(): void {
  registeredDefaultToolIds.clear();
}

function registerDefaultTool(registry: McpToolRegistry, spec: AgentToolSpec): void {
  if (registeredDefaultToolIds.has(spec.id)) return;
  registry.registerAgentTool(spec);
  registeredDefaultToolIds.add(spec.id);
}
