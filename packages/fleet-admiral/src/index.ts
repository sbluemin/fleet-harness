export {
  createSystemPromptBuilder,
  type SystemPromptBuilder,
} from "./prompts/index.js";
export { buildGatewaySystemPrompt } from "./prompts/gateway.js";
export {
  resolveDoctrineFromCliId,
  type AdmiralDoctrine,
} from "./protocols/doctrine.js";
export { getAllStandingOrders } from "./protocols/standing-orders/index.js";
export {
  FLEET_MCP_SERVER_NAME,
  isHostSessionToolAllowed,
} from "./tools.js";

// Agent CLI launch-spec types (구조적 DI 타입 포함)
export {
  MAX_LAUNCH_PROMPT_CHARS,
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
  assertLaunchCommandLineBudget,
  assertLaunchPromptShimSafe,
  estimateWindowsCommandLineChars,
  LaunchPromptError,
  resolveLaunchCommandLineLimit,
  sanitizeLaunchPrompt,
  WINDOWS_CMD_SHIM_COMMAND_LINE_MAX_CHARS,
  WINDOWS_CREATE_PROCESS_COMMAND_LINE_MAX_CHARS,
  type LaunchCommandLineLimit,
  type LaunchPromptErrorCode,
} from "./agent-cli/prompt.js";

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
export {
  prepareAiGatewayLaunchProfile,
  writeGatewayModelCacheForHome,
  type AiGatewayLaunchEnvOptions,
} from "./ai-gateway/launch-env.js";

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
  parseGatewayQuotaSnapshot,
} from "./ai-gateway/quota-snapshot.js";
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
export {
  NATIVE_CLAUDE_EFFORTS,
  NATIVE_CLAUDE_MODEL_ALIASES,
  resolveNativeClaudeModelAlias,
} from "./agent-cli/claude/definitions.js";

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

// PTY 주입은 위 injection이 플러그인 렌더까지 함께 하지만, SDK 세션은 렌더된 경로만 필요하다.
export {
  createAgentCliPlugin,
  type AgentCliPlugin,
  type CreateAgentCliPluginOptions,
} from "./agent-cli/plugin/index.js";

export {
  FLEET_PLUGIN_NAME,
  GENERAL_PURPOSE_AGENT_PROMPT,
  buildGatewayAgentFiles,
  buildGatewayCustomAgents,
  toGatewayAgentName,
  toGatewayAgentSelector,
  type ClaudeCustomAgentDefinition,
  type ClaudeCustomAgents,
  type GatewayAgentFile,
  type GatewayEffortExposure,
} from "./agent-cli/gateway-agents.js";

export {
  GATEWAY_DISABLED_CLAUDE_SKILLS,
  buildDisabledSkillOverrides,
  type ClaudeSkillOverride,
} from "./agent-cli/gateway-skills.js";

// Fleet 에이전트 in-process MCP 런타임 라이프사이클
export {
  createFleetGatewayAgentRuntimeLifecycle,
  type FleetGatewayAgentRuntimeLifecycle,
  type FleetGatewayAgentRuntimeLifecycleDeps,
} from "./agent-runtime/gateway-runtime.js";

// PTY 메시지 주입 종단
export {
  createDelayedPtyWriter,
  formatPtyMessage,
  sanitizePtyMessageText,
  type DelayedPtyWriter,
  type PtyMessageDeliveryOptions,
  type PtyWriteSink,
} from "./agent-runtime/pty-message-writer.js";
