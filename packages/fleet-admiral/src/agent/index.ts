import * as models from "@sbluemin/fleet-infra/agent";
import * as connections from "@sbluemin/fleet-infra/agent";
import * as executor from "@sbluemin/fleet-infra/agent";
import { registerDefaultAgentTools } from "./bootstrap.js";
import * as tools from "./tools.js";

export type {
  AgentToolCtx,
  AgentToolSpec,
  McpCallToolResult,
} from "./types.js";
export type {
  ParsedModelId,
  ProviderInfo,
  SelectableThinkingLevel,
  CliCapability,
} from "@sbluemin/fleet-infra/agent";
export type { SessionPersistencePort } from "@sbluemin/fleet-infra/agent";
export type {
  ExecuteOptions,
  ExecResult,
} from "@sbluemin/fleet-infra/agent";

export {
  clearAllDefaultTools,
  clearAllExtraTools,
  EXECUTOR_MCP_TOOL_IDS,
  getAllAgentTools,
  getExecutorMcpTools,
  invoke,
  list,
  listSpecs,
  registerAgentTool,
  registerExecutorTool,
  registerExtraTools,
  renderAgentToolDoctrineTag,
  unregisterExtraTools,
} from "./tools.js";
export {
  registerDefaultAgentTools,
} from "./bootstrap.js";
export {
  getSessionIdFor,
  disconnect,
  disconnectAll,
  cleanIdle,
} from "@sbluemin/fleet-infra/agent";
export {
  parseModelId,
  buildModelId,
  buildProviderId,
  getProviderIds,
  isFleetProviderId,
  parseProviderId,
  listProviders,
  getCliModels,
  getCliEffortLevels,
  getSelectableThinkingLevels,
  SELECTABLE_THINKING_LEVELS,
  hashSystemPrompt,
  CLI_CAPABILITIES,
} from "@sbluemin/fleet-infra/agent";
export {
  executeWithPool,
  executeOneShot,
} from "@sbluemin/fleet-infra/agent";

export const agent = {
  registerDefaultAgentTools,
  tools,
  connections,
  models,
  executor,
};
