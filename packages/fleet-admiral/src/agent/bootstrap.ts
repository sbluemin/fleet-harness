import { registerAgentTool } from "@sbluemin/fleet-mcp-server";

import { buildCarrierDispatchToolSpec, buildCarrierJobsToolSpec } from "@sbluemin/fleet-carriers";
import type { AgentToolSpec } from "./types.js";

const registeredDefaultToolIds = new Set<string>();

export function registerDefaultAgentTools(): void {
  registerDefaultTool(buildCarrierDispatchToolSpec());
  registerDefaultTool(buildCarrierJobsToolSpec());
}

export function resetDefaultAgentToolsRegistration(): void {
  registeredDefaultToolIds.clear();
}

function registerDefaultTool(spec: AgentToolSpec): void {
  if (registeredDefaultToolIds.has(spec.id)) return;
  registerAgentTool(spec);
  registeredDefaultToolIds.add(spec.id);
}
