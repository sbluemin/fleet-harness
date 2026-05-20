import { registerFleetCoreDefaultAgentTools } from "./bootstrap.js";
import * as connections from "./connections.js";
import * as executor from "./executor.js";
import * as models from "./models.js";
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
} from "./models.js";
export type { SessionPersistencePort } from "./internal/session-runtime.js";
export type {
  ExecuteOptions,
  ExecResult,
} from "./executor.js";

export {
  clearAllDefaultTools,
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
} from "./tools.js";
export {
  registerFleetCoreDefaultAgentTools,
} from "./bootstrap.js";
export {
  getSessionIdFor,
  disconnect,
  disconnectAll,
  cleanIdle,
} from "./connections.js";
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
} from "./models.js";
export {
  executeWithPool,
  executeOneShot,
} from "./executor.js";

export const agent = {
  registerFleetCoreDefaultAgentTools,
  tools,
  connections,
  models,
  executor,
};
