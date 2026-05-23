import { carrier, carrierJobs, store, taskforce } from "@sbluemin/fleet-carriers";

import { agent } from "./agent/index.js";
import * as constants from "./constants.js";
import { createFleetAdmiral } from "./factory.js";
import * as mcp from "./mcp.js";
import * as prompts from "./prompts.js";
import * as protocols from "./protocols/index.js";

export type { FleetAdmiral, FleetAdmiralConfig, FleetAdmiralDeps } from "./factory.js";
export { createFleetAdmiral } from "./factory.js";
export * from "./mcp.js";
export * from "./prompts.js";
export * from "./protocols/index.js";
export * from "./protocols/standing-orders/index.js";
export {
  TASKFORCE_CLI_TYPES,
} from "@sbluemin/fleet-carriers";
export type {
  BackendProgress,
  CarrierCategory,
  CarrierConfig,
  CarrierJobKind,
  CarrierJobStatus,
  CarrierJobStreamEvent,
  CarrierJobsParams,
  CarrierMetadata,
  FleetStoreSnapshot,
  FleetStoreWriteFingerprint,
  RequestBlock,
  TaskForceCliType,
  TaskForceResult,
  TaskForceState,
  TrackKind,
  TrackMeta,
  TrackStatus,
} from "@sbluemin/fleet-carriers";
export type * from "@sbluemin/fleet-carriers";
export type {
  AgentToolCtx,
  AgentToolSpec,
  McpCallToolResult,
} from "./agent/types.js";
export type {
  ParsedModelId,
  ProviderInfo,
  SelectableThinkingLevel,
  CliCapability,
  ExecuteOptions,
  ExecResult,
} from "./agent/index.js";
export {
  clearAllDefaultTools,
  clearAllExtraTools,
  EXECUTOR_MCP_TOOL_IDS,
  cleanIdle,
  disconnect,
  disconnectAll,
  executeWithPool,
  executeOneShot,
  getAllAgentTools,
  getExecutorMcpTools,
  invoke,
  list,
  listSpecs,
  getSessionIdFor,
  registerAgentTool,
  registerDefaultAgentTools,
  registerExecutorTool,
  registerExtraTools,
  renderAgentToolDoctrineTag,
  unregisterExtraTools,
} from "./agent/index.js";

export const fleetAdmiral = {
  create: createFleetAdmiral
} as const;

export const admiral = {
  agent,
  carrier,
  taskforce,
  carrierJobs,
  protocols,
  store,
  mcp,
  prompts,
  constants,
};
