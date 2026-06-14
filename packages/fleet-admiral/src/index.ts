export {
  createSystemPromptBuilder,
  type SystemPromptBuilder,
} from "./prompts.js";
export {
  FLEET_MCP_SERVER_NAME,
  getExecutorMcpTools,
  registerAgentToolDefaults,
} from "./tools.js";

// Agent CLI launch-spec types (구조적 DI 타입 포함)
export {
  type AgentCliDefinition,
  type AgentCliId,
  type AgentCliInjectionCapability,
  type AgentCliMcpServerArg,
  type AgentCliProfile,
  type AgentCliProfileOptions,
  type CliMessagePolicy,
  type CodexCommandResult,
  type CodexPluginRegistrationCommand,
  type FleetHookExec,
} from "./agent-cli/types.js";

// Agent CLI 프로파일/레지스트리 해석기
export {
  type AgentCliMetadata,
  getAgentCliIds,
  getAgentCliMetadata,
  getDefaultAgentCliId,
  parseAgentCliId,
  resolveAgentCliId,
  resolveAgentCliProfile,
  type ResolveAgentCliProfileOptions,
} from "./agent-cli/registry.js";

// Agent CLI 주입 능력 맵
export { getAgentCliInjectionCapability } from "./agent-cli/capabilities.js";

// Agent CLI 프로파일/플러그인/인자 주입 조립
export {
  injectAgentCliProfile,
  type InjectAgentCliProfileOptions,
} from "./agent-cli/injection.js";

// Fleet 에이전트 in-process MCP 런타임 라이프사이클
export {
  createFleetAgentRuntimeLifecycle,
  type FleetAgentRuntimeLifecycle,
  type FleetAgentRuntimeLifecycleDeps,
  type FleetAgentRuntimeServices,
  type FleetAgentRuntimeToolRegistration,
} from "./agent-runtime/index.js";
