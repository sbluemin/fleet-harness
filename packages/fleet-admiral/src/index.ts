export {
  createSystemPromptBuilder,
  type SystemPromptBuilder,
  type SystemPromptBuildOptions,
} from "./prompts/index.js";
export {
  resolveDoctrineFromCliId,
  type AdmiralDoctrine,
} from "./protocols/doctrine.js";
export {
  getAllStandingOrders,
  getStandingOrdersForDoctrine,
} from "./protocols/standing-orders/index.js";
export {
  FLEET_PROTOCOL_GATE_PROMPT,
  getProtocolGatePrompt,
} from "./protocols/fleet-action.js";
export {
  CARRIER_OPERATION_TOOL_IDS,
  FLEET_MCP_SERVER_NAME,
  getExecutorMcpTools,
  isHostSessionToolAllowed,
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
  type FleetHookExec,
  type PtyInputChunk,
} from "./agent-cli/types.js";

export {
  KIMI_AUTH_PROVIDER_ID,
  KIMI_CODE_API_BASE_URL,
  KIMI_CODE_MODEL,
  OPENCODE_AUTH_PROVIDER_ID,
  OPENCODE_GO_API_BASE_URL,
  OPENCODE_GO_MODEL,
  validateKimiAuthKey,
  validateOpencodeGoAuthKey,
} from "./ai-gateway/auth.js";
export type { AuthKeyValidationResult } from "./ai-gateway/auth.js";

// AI Gateway 모델 로드아웃 — 호스트가 Phase에 모델/강도를 배치할 때 참조하는 로스터
export {
  GATEWAY_MODELS_TOOL_ID,
  buildGatewayModelsToolSpec,
  type GatewayModelsSelection,
  type GatewayModelsToolDeps,
} from "./ai-gateway/gateway-models-tool.js";
export {
  buildGatewayLoadout,
  type GatewayLoadout,
  type GatewayLoadoutModel,
  type GatewayLoadoutProvider,
  type GatewayLoadoutProviderQuota,
  type GatewayLoadoutQuotaWindow,
  type GatewayProviderQuota,
  type GatewayQuotaSnapshot,
  type GatewayQuotaWindow,
  type GatewayWindowPressure,
} from "./ai-gateway/model-loadout.js";
export {
  declaredRoleFitIdentities,
  gatewayRoleFit,
  type GatewayRoleAxis,
  type GatewayRoleFit,
  type GatewayRoleFitEntry,
} from "./ai-gateway/role-fit.js";

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
  createSessionCaptureHookExec,
} from "./agent-cli/session-capture-hook.js";

export {
  injectAgentCliProfile,
  type InjectAgentCliProfileOptions,
} from "./agent-cli/injection.js";

export {
  GENERAL_PURPOSE_AGENT_PROMPT,
  buildGatewayCustomAgents,
  toGatewayAgentName,
  type ClaudeCustomAgentDefinition,
  type ClaudeCustomAgents,
  type GatewayEffortExposure,
} from "./agent-cli/gateway-agents.js";

export {
  GATEWAY_DISABLED_CLAUDE_SKILLS,
  buildDisabledSkillOverrides,
  type ClaudeSkillOverride,
} from "./agent-cli/gateway-skills.js";

// Fleet 에이전트 in-process MCP 런타임 라이프사이클
export {
  createFleetAgentRuntimeLifecycle,
  type FleetAgentRuntimeLifecycle,
  type FleetAgentRuntimeLifecycleDeps,
  type FleetAgentRuntimeServices,
  type FleetAgentRuntimeToolRegistration,
} from "./agent-runtime/index.js";

// Carrier result reminder 주입 종단
export {
  createCarrierResultReminderRouter,
  createDelayedPtyWriter,
  formatCarrierResultReminderMessage,
  sanitizeCarrierResultReminder,
  type DelayedPtyWriter,
  type PtyMessageDeliveryOptions,
  type PtyWriteSink,
} from "./agent-runtime/reminder-router.js";
