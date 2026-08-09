/**
 * @dotobokuri/core-agent
 *
 * 도구 어휘, MCP 서빙, Claude 게이트웨이 SDK, 업데이트 원시기능.
 *
 * 두 종류의 MCP가 있고 서로 다른 물건이다. `mcp/served/`는 자식이 포트와 Bearer 토큰으로
 * 접속하는 HTTP 서버고, `mcp/embedded/`는 자식 프로세스에 값으로 건네는 in-process 도구다.
 *
 * 소비처는 `@anthropic-ai/claude-agent-sdk`를 직접 의존하지 않는다. 그 계약은 문서가 아니라
 * `scripts/check-claude-agent-sdk-boundary.mjs`가 매 PR에 강제하며, 이 패키지 안에서도
 * `src/claude/vendor-sdk.ts` 한 곳만 그 이름을 안다.
 */
export type {
  AgentToolCtx,
  AgentToolSpec,
  McpCallToolResult,
  McpTool,
  RegisteredTool,
  RegisterExecutorToolOptions,
} from "./tools/spec.js";
export type {
  JsonRpcPayload,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcResultPayload,
  McpServerConfig,
  TrackStatus,
} from "./mcp/types.js";
export type {
  McpRouterRuntime,
  McpRouterServer,
  ToolCallArrivedCallback,
} from "./mcp/served/router.js";
export type {
  McpToolRegistry,
} from "./tools/registry.js";
export type {
  McpToolSnapshotStore,
} from "./tools/snapshot.js";
export type {
  CreateServedMcpEndpointDeps,
  ServedMcpEndpoint,
  ServedMcpEndpointInfo,
} from "./mcp/served/jsonrpc.js";
export type {
  CoreExecutorMcpSession,
  CoreExecutorMcpSessionRequest,
  CreateExecutorSessionManagerDeps,
  ExecutorMcpRuntimeProvider,
  ExecutorMcpRuntimeProviderRuntime,
  ExecutorMcpRouterRuntime,
  ExecutorMcpSession,
  ExecutorMcpSessionRequest,
  ExecutorPort,
  ExecutorPortRuntime,
  ExecutorEndpoint,
  ExecutorRuntime,
  ExecutorServerEndpoint,
  ExecutorServerToken,
  ExecutorSessionManager,
  ExecutorSessionRequest,
} from "./mcp/served/session-manager.js";
export type {
  UpdateChannel,
} from "./update/version-check.js";
export type {
  CreateGlobalPackageUpdaterDeps,
  GlobalPackageBinaryResolver,
  GlobalPackageCanWrite,
  GlobalPackageCurrentVersionResolver,
  GlobalPackageExecFile,
  GlobalPackageInstallContext,
  GlobalPackageInstallProcess,
  GlobalPackageManagerCommand,
  GlobalPackageManagerDetection,
  GlobalPackageManagerInstall,
  GlobalPackageRealpath,
  GlobalPackageRootResolver,
  GlobalPackageSpawnContext,
  GlobalPackageSpawnInstall,
  GlobalPackageUpdateOptions,
  GlobalPackageUpdateReason,
  GlobalPackageUpdateResult,
  GlobalPackageUpdateStatus,
  GlobalPackageUpdater,
  GlobalPackageUpdaterHook,
  GlobalPackageUpdaterReport,
  GlobalPackageVersionResolver,
} from "./update/global-package-updater.js";
export {
  cleanupExecutorSession,
  installExecutorToolCallRouter,
  registerExecutorSessionTools,
  specToMcpTool,
} from "./mcp/served/router.js";
export {
  createMcpToolRegistry,
} from "./tools/registry.js";
export {
  convertToolSchema,
  createMcpToolSnapshotStore,
} from "./tools/snapshot.js";
export {
  createServedMcpEndpoint,
} from "./mcp/served/jsonrpc.js";
export {
  createExecutorMcpRuntimeProviderRuntime,
  createExecutorPortRuntime,
  createExecutorSessionManager,
  executorMcpRuntimeProviderRuntime,
  executorPortRuntime,
} from "./mcp/served/session-manager.js";
export {
  assertInternalMcpTokensNotShared,
  resolveBuiltinExternalMcpServers,
} from "./mcp/served/external-catalog.js";
export {
  fetchLatestVersion,
  isVersionGreater,
} from "./update/version-check.js";
export {
  createGlobalPackageUpdater,
} from "./update/global-package-updater.js";
