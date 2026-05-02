/**
 * admiral/agent/internal/state — ACP provider 공유 상태.
 *
 * 세션 맵, 브릿지 스코프, MCP 토큰, 런타임 컨텍스트 빌더 슬롯을 관리.
 * 외부에서는 admiral/agent 공개 API를 통해서만 접근. 내부 setter는 internal 모듈만 사용.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import type { CliType, IUnifiedAgentClient } from "@sbluemin/unified-agent";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentSessionState {
  readonly sessionKey: string;
  readonly scopeKey: string;
  client: IUnifiedAgentClient | null;
  sessionId: string | null;
  readonly cwd: string;
  lastSystemPromptHash: string;
  readonly cli: CliType;
  firstPromptSent: boolean;
  currentModel: string;
  mcpSessionToken?: string;
  toolHash?: string;
  pendingToolCalls: PendingToolCallState[];
  pendingToolCallNotifier: (() => void) | null;
  activePrompt: ActivePromptState | null;
  sessionGeneration: number;
  needsRecovery: boolean;
  lastError: string | null;
}

export interface ActivePromptState {
  readonly promptId: string;
  readonly sessionGeneration: number;
  retryConsumed: boolean;
  assistantOutputStarted: boolean;
  builtinToolStarted: boolean;
  mcpToolUseStarted: boolean;
}

export interface PendingToolCallState {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  emitted: boolean;
}

export interface AgentSessionLaunchConfig {
  readonly cli: CliType;
  readonly backendModel: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly effort?: string;
  readonly env?: Record<string, string>;
}

export interface AgentProviderState {
  readonly sessions: Map<string, AgentSessionState>;
  readonly sessionKeysByScope: Map<string, Set<string>>;
  readonly toolCallToSessionKey: Map<string, string>;
  readonly bridgeScopeSessionKeys: Map<string, string>;
  readonly sessionLaunchConfigs: Map<string, AgentSessionLaunchConfig>;
}

export type CliRuntimeContextBuilder = (userRequest: string) => string;

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** provider 상태 싱글턴 반환 (지연 초기화) */
export function getOrInitState(): AgentProviderState {
  if (!agentProviderState) {
    agentProviderState = createInitialState();
  }
  return agentProviderState;
}

/** provider 상태 리셋 — shutdown 시 호출 */
export function resetState(): void {
  agentProviderState = null;
  cliRuntimeContextBuilder = null;
}

// ── bridge scope ──

export function setBridgeScopeSession(scopeName: string, sessionKey: string): void {
  getOrInitState().bridgeScopeSessionKeys.set(scopeName, sessionKey);
}

export function getBridgeScopeSession(scopeName: string): string | undefined {
  return getOrInitState().bridgeScopeSessionKeys.get(scopeName);
}

export function clearBridgeScopeSessionBySessionKey(sessionKey: string): void {
  const state = getOrInitState();
  for (const [scopeName, mappedSessionKey] of state.bridgeScopeSessionKeys.entries()) {
    if (mappedSessionKey === sessionKey) {
      state.bridgeScopeSessionKeys.delete(scopeName);
    }
  }
}

// ── session launch config ──

export function setSessionLaunchConfig(
  sessionKey: string,
  config: AgentSessionLaunchConfig,
): void {
  const state = getOrInitState();
  const previous = state.sessionLaunchConfigs.get(sessionKey);
  state.sessionLaunchConfigs.set(sessionKey, { ...previous, ...config });
}

export function getSessionLaunchConfig(sessionKey: string): AgentSessionLaunchConfig | undefined {
  return getOrInitState().sessionLaunchConfigs.get(sessionKey);
}

export function clearSessionLaunchConfig(sessionKey: string): void {
  getOrInitState().sessionLaunchConfigs.delete(sessionKey);
}

// ── runtime context builder (internal only) ──

export function setCliRuntimeContext(builder: CliRuntimeContextBuilder | null): void {
  cliRuntimeContextBuilder = builder;
}

export function getCliRuntimeContext(): CliRuntimeContextBuilder | null {
  return cliRuntimeContextBuilder;
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal
// ═══════════════════════════════════════════════════════════════════════════

let agentProviderState: AgentProviderState | null = null;
let cliRuntimeContextBuilder: CliRuntimeContextBuilder | null = null;

function createInitialState(): AgentProviderState {
  return {
    sessions: new Map(),
    sessionKeysByScope: new Map(),
    toolCallToSessionKey: new Map(),
    bridgeScopeSessionKeys: new Map(),
    sessionLaunchConfigs: new Map(),
  };
}
