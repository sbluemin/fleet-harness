import * as bridge from "./bridge.js";
import * as connections from "./connections.js";
import * as events from "./events.js";
import * as executor from "./executor.js";
import * as lifecycle from "./lifecycle.js";
import * as models from "./models.js";
import * as serviceStatus from "./service-status.js";
import * as session from "./session.js";
import * as tools from "./tools.js";

export type {
  AgentStreamEvent,
  AgentToolCtx,
  AgentToolSpec,
  ConversationHistoryEntry,
  McpCallToolResult,
  SendMessageRequest,
  SessionHandle,
} from "./types.js";
export type { AgentStreamHandler } from "./events.js";
export type {
  EnsureOptions,
} from "./session.js";
export type {
  ToolResultEnvelope,
} from "./internal/session-engine.js";
export type {
  ParsedModelId,
  ProviderInfo,
  SelectableThinkingLevel,
  CliCapability,
} from "./models.js";
export type { ServiceStatusEvent, ServiceSnapshot } from "./service-status.js";
export type { LaunchCommandData, BridgeOptions } from "./bridge.js";
export type { AgentSessionLaunchConfig } from "./internal/state.js";
export type {
  ExecuteOptions,
  ExecResult,
} from "./executor.js";

export {
  clearStreamHandlers,
  emitStreamEvent,
  registerStreamHandler,
  unregisterStreamHandler,
} from "./events.js";
export {
  clearAllDefaultTools,
  clearAllExtraTools,
  getAllAgentTools,
  invoke,
  list,
  listSpecs,
  registerAgentTool,
  registerExtraTools,
  renderAgentToolDoctrineTag,
  unregisterExtraTools,
} from "./tools.js";
export {
  ensure,
  sendMessage,
  deliverToolResults,
  resolveSession,
} from "./session.js";
export {
  bindHostSession,
  shutdownAllSessions,
} from "./lifecycle.js";
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
  read as readServiceStatus,
  refresh as refreshServiceStatus,
  events as serviceStatusEvents,
} from "./service-status.js";
export {
  buildLaunchCommand,
} from "./bridge.js";
export {
  executeWithPool,
  executeOneShot,
} from "./executor.js";

export const agent = {
  tools,
  session,
  events,
  lifecycle,
  connections,
  models,
  serviceStatus,
  bridge,
  executor,
};
