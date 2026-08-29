/**
 * `@dotobokuri/core-agent/claude`
 *
 * 별도 진입점인 이유는 모듈 그래프다. 루트 파사드가 이것을 재수출하면 업데이트 확인처럼
 * Claude와 무관한 표면 하나를 쓰는 소비자까지 vendor SDK와 게이트웨이 카탈로그를 import 시점에
 * 끌어오게 된다.
 */
export { createClaudeGatewaySdk } from "./sdk.js";
export { createClaudeExecutionEventDecoder } from "./execution-events.js";
export { createClaudeExecutionLoop } from "./execution-loop.js";
export { defineTool, createEmbeddedMcpServer } from "../mcp/embedded/server.js";
export type {
  ClaudeGatewayAgent,
  ClaudeGatewayCanUseTool,
  ClaudeGatewayCommand,
  ClaudeGatewayContextCategory,
  ClaudeGatewayContextUsage,
  ClaudeGatewayEffort,
  ClaudeGatewayMcpServer,
  ClaudeGatewayMcpServerOptions,
  ClaudeGatewayMessage,
  ClaudeGatewayServedMcpServer,
  ClaudeGatewayPermissionMode,
  ClaudeGatewayRun,
  ClaudeGatewaySdk,
  ClaudeGatewaySdkOptions,
  ClaudeGatewaySession,
  ClaudeGatewaySessionRequest,
  ClaudeGatewaySystemPrompt,
  ClaudeGatewayTool,
  ClaudeGatewayToolExtras,
  ClaudeGatewayToolPermission,
  ClaudeGatewayToolPermissionContext,
  ClaudeGatewayToolResult,
  ClaudeGatewayTurn,
} from "./contracts.js";
export type {
  ClaudeExecutionEvent,
  ClaudeExecutionEventDecoder,
} from "./execution-events.js";
export type {
  ClaudeExecutionContinuation,
  ClaudeExecutionLoop,
  ClaudeExecutionLoopOptions,
  ClaudeExecutionSettlement,
  ClaudeExecutionTurn,
} from "./execution-loop.js";
export { readClaudeSessionTitle } from "./session-info.js";
