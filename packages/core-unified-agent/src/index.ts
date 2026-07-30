/**
 * @dotobokuri/core-unified-agent
 * Codex App Server, Claude Code 등 Agent 백엔드 통합 SDK
 *
 * @example
 * ```typescript
 * import { UnifiedAgent } from '@dotobokuri/core-unified-agent';
 *
 * const client = await UnifiedAgent.build({ cli: 'claude' });
 * client.on('messageChunk', (text) => process.stdout.write(text));
 * await client.connect({ cwd: '/my/workspace', cli: 'claude' });
 * await client.sendMessage('이 프로젝트를 분석해줘');
 * ```
 */

// === 통합 클라이언트 ===
export { UnifiedAgent } from './client/UnifiedAgent.js';
export type {
  UnifiedAgentBuildOptions,
  ConnectResult,
  ConnectionInfo,
  IUnifiedAgentClient,
  UnifiedClientEvents,
} from './client/IUnifiedAgentClient.js';

export { UnifiedClaudeAgentClient } from './client/UnifiedClaudeAgentClient.js';
export { UnifiedCodexAgentClient } from './client/UnifiedCodexAgentClient.js';
export { UnifiedCursorAgentClient } from './client/UnifiedCursorAgentClient.js';

// === 모델 레지스트리 ===
export {
  getModelsRegistry,
  getProviderModels,
  getProviderModelIds,
  getEffort,
  getEffortLevels,
  getModelContextWindow,
} from './models/ModelRegistry.js';

export type {
  ModelsRegistry,
  ProviderModelInfo,
  ModelEntry,
  Effort,
  ThinkingLevel,
  EffortLevel,
} from './models/schemas.js';

// === 연결 모듈 ===
export { BaseConnection, type BaseConnectionOptions } from './connection/BaseConnection.js';
export { AcpConnection, createIdleTimeoutRace, type AcpConnectionOptions, type AcpConnectionEventMap } from './connection/AcpConnection.js';
export {
  createSessionIdentityResolver,
  type SessionIdentityResolver,
  type SessionIdentityResolverOptions,
} from './client/SessionIdentityResolver.js';

// === CLI 감지 ===
export { CliDetector } from './detector/CliDetector.js';

// === 서비스 상태 ===
export type {
  ServiceSnapshot,
  HealthStatus,
  ProviderKey,
} from './service-status/index.js';

// === CLI 설정 ===
export {
  CLI_BACKENDS,
  createSpawnConfig,
  getBackendConfig,
  getAllBackendConfigs,
} from './config/CliConfigs.js';

export type { CliType } from './config/CliConfigs.js';

// === 공식 ACP SDK re-export ===
export {
  ClientSideConnection,
  AgentSideConnection,
  ndJsonStream,
  RequestError,
} from '@agentclientprotocol/sdk';

export type {
  Client as AcpClient,
  Agent as AcpAgent,
  Stream as AcpStream,
} from '@agentclientprotocol/sdk';

// === 타입 ===
export type {
  // 공통
  ConnectionState,
  ClientInfo,
  ConnectionEvents,
  StructuredLogEntry,
} from './types/common.js';

export type {
  // ACP (공식 SDK alias)
  AcpInitializeParams,
  AcpInitializeResult,
  AcpSessionNewParams,
  AcpSessionNewResult,
  AcpSessionLoadParams,
  AcpSessionLoadResult,
  AcpSessionCancelParams,
  AcpSessionPromptParams,
  AcpPromptResponse,
  AcpSessionSetModeParams,
  AcpSessionSetModelParams,
  AcpSessionSetConfigParams,
  AcpSessionUpdateParams,
  AcpSessionUpdate,
  AcpAvailableCommandsUpdate,
  AcpAvailableCommand,
  AcpPermissionRequestParams,
  AcpPermissionOption,
  AcpPermissionResponse,
  AcpFileReadParams,
  AcpFileReadResponse,
  AcpFileWriteParams,
  AcpFileWriteResponse,
  AcpContentBlock,
  AcpTextContent,
  AcpImageContent,
  AcpResourceLink,
  AcpConfigOption,
  AcpSessionMode,
  AcpStopReason,
  AcpSessionModelState,
  AcpModelInfo,
  AcpModelId,
  AcpToolCall,
  AcpToolCallUpdate,
  AcpToolCallContent,
  AcpToolCallStatus,
  AcpToolKind,
} from './types/acp.js';

export type {
  // 설정
  ProtocolType,
  AgentMode,
  CliSpawnConfig,
  CliBackendConfig,
  ConnectionOptions,
  McpServerConfig,
  CliDetectionResult,
  UnifiedClientOptions,
} from './types/config.js';

// === 유틸리티 ===
export { cleanEnvironment, isWindows } from './utils/env.js';
export { killProcess } from './utils/process.js';
export { resolveNpxPath, buildNpxArgs } from './utils/npx.js';
