import { registerAgentTool } from "@sbluemin/fleet-mcp-server";

import { buildCarrierJobsToolSpec } from "../carrier-jobs/tool-spec.js";
import { buildCarrierDispatchToolSpec } from "../carrier/tool-spec.js";
import { buildSquadronToolSpec } from "../squadron/tool-spec.js";
import { buildTaskForceToolSpec } from "../taskforce/tool-spec.js";
import type { AgentToolSpec } from "./types.js";

const registeredDefaultToolIds = new Set<string>();

export function registerFleetCoreDefaultAgentTools(): void {
  registerDefaultTool(buildCarrierDispatchToolSpec());

  const squadron = buildSquadronToolSpec();
  const taskForce = buildTaskForceToolSpec();

  if (squadron) registerDefaultTool(squadron);
  if (taskForce) registerDefaultTool(taskForce);

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
