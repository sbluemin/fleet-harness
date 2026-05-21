import { registerAgentTool } from "@sbluemin/fleet-mcp-server";

import { buildCarrierJobsToolSpec } from "../carrier-jobs/tool-spec.js";
import { buildCarrierDispatchToolSpec } from "../carrier/tool-spec.js";
import type { AgentToolSpec } from "./types.js";

const registeredDefaultToolIds = new Set<string>();

export function registerFleetCoreDefaultAgentTools(): void {
  registerDefaultTool(buildCarrierDispatchToolSpec());
  registerDefaultTool(buildCarrierJobsToolSpec());
}

export function resetFleetCoreDefaultAgentToolsRegistration(): void {
  registeredDefaultToolIds.clear();
}

function registerDefaultTool(spec: AgentToolSpec): void {
  if (registeredDefaultToolIds.has(spec.id)) return;
  registerAgentTool(spec);
  registeredDefaultToolIds.add(spec.id);
}
