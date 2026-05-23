import {
  EXECUTOR_MCP_TOOL_IDS,
  clearAllDefaultTools as clearLeafDefaultTools,
  clearAllExtraTools,
  getAllAgentTools,
  getExecutorMcpToolsForCarrier,
  invoke,
  list,
  listSpecs,
  registerAgentTool,
  registerExecutorTool,
  registerExtraTools,
  renderAgentToolDoctrineTag,
  unregisterExtraTools,
} from "@sbluemin/fleet-mcp-server";

import { getRegisteredCarrierConfig } from "@sbluemin/fleet-carriers";
import { resetFleetCoreDefaultAgentToolsRegistration } from "./bootstrap.js";
import type { AgentToolSpec } from "./types.js";

export {
  EXECUTOR_MCP_TOOL_IDS,
  clearAllExtraTools,
  getAllAgentTools,
  invoke,
  list,
  listSpecs,
  registerAgentTool,
  registerExecutorTool,
  registerExtraTools,
  renderAgentToolDoctrineTag,
  unregisterExtraTools,
};
export { registerFleetCoreDefaultAgentTools } from "./bootstrap.js";

export function getExecutorMcpTools(carrierId?: string): AgentToolSpec[] {
  const metadataIds = carrierId
    ? getRegisteredCarrierConfig(carrierId)?.carrierMetadata?.allowedExecutorTools ?? []
    : [];
  return getExecutorMcpToolsForCarrier(carrierId, metadataIds);
}

export function clearAllDefaultTools(): void {
  clearLeafDefaultTools();
  resetFleetCoreDefaultAgentToolsRegistration();
}
