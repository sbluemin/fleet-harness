/**
 * admiral/agent/internal/session-engine — ACP 세션 수명주기 핵심.
 *
 * ensureSession: 연결 또는 재사용. drift/model/dead-client 감지.
 * disconnectSession: 세션 정리.
 * buildConnectOptions: ACP 연결 옵션 구성.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import {
  UnifiedAgent,
  getReasoningEffortLevels,
  type CliType,
  type IUnifiedAgentClient,
  type McpServerConfig,
  type UnifiedClientOptions,
} from "@sbluemin/unified-agent";

import { resolveAuthEnv } from "../../../services/auth/index.js";
import { getLogAPI } from "../../../services/log/store.js";
import { emitStreamEvent } from "../events.js";
import {
  type AgentSessionState,
  type AgentProviderState,
  getOrInitState,
  setSessionLaunchConfig,
} from "./state.js";
import {
  getSessionStore,
  classifyResumeFailure,
  isDeadSessionError,
} from "./session-runtime.js";
import {
  installToolCallRouter,
  detachToolCallRouter,
  removeSessionTools,
  registerSessionTools,
  closeLogicalPromptRouting,
  clearSessionRoutingState,
  consumePendingToolCall,
  getPendingToolCallHead,
  emitNextPendingToolCall,
  resolveToolResult,
  getSessionToolNames,
  metadataToMcpTool,
} from "./mcp-router.js";
import { wireStreamEmitter } from "./event-normalizer.js";
import { list } from "../tools.js";
import { buildRuntimeContextPrompt } from "../../prompts.js";
import type { ConversationHistoryEntry, SendMessageRequest } from "../types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

type McpTool = { name: string; description?: string; parameters?: unknown; [key: string]: unknown };

export interface ToolResultEnvelope {
  readonly content: unknown;
  readonly isError?: boolean;
  readonly toolCallId?: string;
}

export interface EnsureResult {
  readonly session: AgentSessionState;
  readonly isNewSession: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_KEY_PREFIX = "acp";
const DEFAULT_PROMPT_IDLE_TIMEOUT = 1_800_000;
const TRANSPORT_RECOVERY_PATTERNS = [
  /ACP connection closed/i,
  /connection closed/i,
  /broken pipe/i,
  /EPIPE/i,
  /ECONNRESET/i,
  /disconnect/i,
];

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 세션 확보 또는 신규 생성.
 * CLI 변경, systemPrompt drift, tool hash 변경 시 기존 세션 폐기 후 재생성.
 * 복원된 세션에서는 systemPrompt drift 무시.
 */
export async function ensureSession(
  cli: CliType,
  backendModel: string,
  scopeKey: string,
  cwd: string,
  systemPrompt: string | undefined,
  systemPromptHash: string,
  effortOverrides?: { effort?: string },
): Promise<EnsureResult> {
  const state = getOrInitState();
  const key = getSessionKey(cli, scopeKey);
  let session = getSessionByScope(state, cli, scopeKey);
  const mcpTools = buildAllMcpTools();
  const currentToolHash = computeToolHash(mcpTools);

  // 기존 세션 유효성 검사
  if (session) {
    const cliChanged = session.cli !== cli;
    const isRestoredSession = !session.client && !!session.sessionId;
    const promptDrifted = !isRestoredSession &&
      session.lastSystemPromptHash &&
      session.lastSystemPromptHash !== systemPromptHash;
    const toolsChanged = session.toolHash && currentToolHash &&
      session.toolHash !== currentToolHash;
    const deadClient = !!session.client && !isProviderClientAlive(session.client);
    const needsRecovery = session.needsRecovery || deadClient;

    if (cliChanged || promptDrifted || toolsChanged || needsRecovery) {
      const reason = cliChanged
        ? "CLI 변경"
        : promptDrifted
          ? "systemPrompt drift"
          : toolsChanged
            ? "tool 목록 변경"
            : deadClient
              ? "dead client 감지"
              : "dead-session recovery";
      debug(`세션 폐기: ${reason}`, `(${session.cli} → ${cli})`);
      await session.client?.disconnect().catch(() => {});
      session.client = null;
      if (session.mcpSessionToken) {
        removeSessionTools(session);
        detachToolCallRouter(session);
      }
      removeSession(state, session);
      session = undefined;
    }
  }

  // 기존 세션 재사용 — 모델 변경 시 setModel
  if (session?.client && session.sessionId) {
    if (session.currentModel !== backendModel) {
      debug(`모델 변경 감지: ${session.currentModel} → ${backendModel}`);
      try {
        await session.client.setModel(backendModel);
        session.currentModel = backendModel;
        debug(`setModel 성공: ${backendModel}`);
      } catch (err) {
        debug(`setModel 실패, 세션 재생성으로 fallback:`, errorMessage(err));
        await disconnectSession(session);
        removeSession(state, session);
        session = undefined;
      }
    }
    if (session) {
      if (effortOverrides?.effort) {
        await applyPostConnectConfig(session.client!, session.cli, effortOverrides);
      }
      installToolCallRouter(state, session);
      session.needsRecovery = false;
      session.lastError = null;
      const reuseEnv = await resolveAuthEnv(cli).catch(() => ({}));
      setSessionLaunchConfig(session.sessionKey, {
        cli,
        backendModel: session.currentModel,
        sessionId: session.sessionId ?? "",
        cwd: session.cwd,
        ...(effortOverrides?.effort ? { effort: effortOverrides.effort } : {}),
        ...(Object.keys(reuseEnv).length > 0 ? { env: reuseEnv } : {}),
      });
      debug(`기존 세션 재사용: session=${formatSessionPrefix(session.sessionId!)}`);
      return { session, isNewSession: false };
    }
  }

  // 새 세션 생성
  const sessionToken = crypto.randomUUID();
  let mcpServers: McpServerConfig[] | undefined;
  let mcpActive = false;

  if (mcpTools.length > 0) {
    try {
      const mcpUrl = await getMcpUrl();
      registerSessionTools({ mcpSessionToken: sessionToken } as AgentSessionState, mcpTools);
      mcpServers = [{
        type: "http",
        url: mcpUrl,
        headers: [{ name: "Authorization", value: `Bearer ${sessionToken}` }],
        name: "pi-tools",
        toolTimeout: 1800,
      }];
      mcpActive = true;
      debug(`MCP 활성화: ${mcpTools.length}개 tool`);
    } catch (err) {
      debug(`MCP URL 확보 실패, fallback:`, errorMessage(err));
    }
  }

  const newSession: AgentSessionState = {
    sessionKey: key,
    scopeKey,
    client: null,
    sessionId: null,
    cwd,
    lastSystemPromptHash: systemPromptHash,
    cli,
    firstPromptSent: false,
    currentModel: backendModel,
    mcpSessionToken: mcpActive ? sessionToken : undefined,
    toolHash: currentToolHash,
    pendingToolCalls: [],
    pendingToolCallNotifier: null,
    activePrompt: null,
    sessionGeneration: (session?.sessionGeneration ?? -1) + 1,
    needsRecovery: false,
    lastError: null,
  };

  const store = getSessionStore();
  const storeKey = getHostSessionStoreKey(cli, scopeKey);
  const savedSessionId = store.get(storeKey) ?? undefined;
  let client: IUnifiedAgentClient | null = null;
  let resumedFromSavedSession = false;

  try {
    debug(savedSessionId ? `session/load 복원 시도: session=${formatSessionPrefix(savedSessionId)}` : `새 연결 시작: cli=${cli}`);
    client = await UnifiedAgent.build({ cli, sessionId: savedSessionId });
    let connectResult;
    try {
      connectResult = await client.connect(await buildConnectOptions(
        cli, cwd, backendModel, systemPrompt, mcpServers, savedSessionId,
      ));
      resumedFromSavedSession = !!savedSessionId;
    } catch (connectError) {
      if (!savedSessionId) throw connectError;
      if (classifyResumeFailure(connectError) !== "dead-session") throw connectError;

      debug(`session/load 실패, fresh fallback: session=${formatSessionPrefix(savedSessionId)} ${errorMessage(connectError)}`);
      store.clear(storeKey);
      await client.disconnect().catch(() => {});
      client.removeAllListeners();
      client = await UnifiedAgent.build({ cli });
      resumedFromSavedSession = false;
      connectResult = await client.connect(await buildConnectOptions(
        cli, cwd, backendModel, systemPrompt, mcpServers,
      ));
    }
    await applyPostConnectConfig(client, cli, effortOverrides);
    newSession.client = client;
    newSession.sessionId = connectResult.session?.sessionId ?? client.getConnectionInfo().sessionId ?? null;
    newSession.firstPromptSent = resumedFromSavedSession;
    if (newSession.sessionId) {
      store.set(storeKey, newSession.sessionId);
    }
    registerSession(state, newSession);
    installToolCallRouter(state, newSession);
    const launchEnv = await resolveAuthEnv(cli).catch(() => ({}));
    setSessionLaunchConfig(newSession.sessionKey, {
      cli,
      backendModel,
      sessionId: newSession.sessionId ?? "",
      cwd: newSession.cwd,
      ...(effortOverrides?.effort ? { effort: effortOverrides.effort } : {}),
      ...(Object.keys(launchEnv).length > 0 ? { env: launchEnv } : {}),
    });
    if (newSession.sessionId) {
      debug(`세션 생성 완료: session=${formatSessionPrefix(newSession.sessionId)}`);
    }
    return { session: newSession, isNewSession: true };
  } catch (err) {
    await (client ?? newSession.client)?.disconnect().catch(() => {});
    (client ?? newSession.client)?.removeAllListeners();
    if (mcpActive) removeSessionTools(newSession);
    throw err;
  }
}

/** 세션 연결 해제 */
export async function disconnectSession(
  session: AgentSessionState,
  preserveSessionId = false,
): Promise<void> {
  try {
    if (session.client) {
      await session.client.disconnect().catch(() => {});
    }
  } catch {
    // best-effort
  }
  session.client = null;
  if (!preserveSessionId) {
    session.sessionId = null;
  }
  if (session.mcpSessionToken) {
    removeSessionTools(session);
    detachToolCallRouter(session);
    session.mcpSessionToken = undefined;
  }
  session.pendingToolCallNotifier = null;
}

/**
 * 메시지 전송 — ACP 클라이언트에 프롬프트 발송. 이벤트는 admiral.agent.events로 emit.
 *
 * fleet-core가 자체적으로:
 *  - 첫 프롬프트(firstPromptSent=false)이면 buildInitialPrompt(history)로 XML 구조화 + buildRuntimeContextPrompt 래핑
 *  - follow-up이면 buildRuntimeContextPrompt만 적용
 * host adapter는 raw userRequest와 history만 전달, 프롬프트 조립 책임은 core 내부.
 */
export async function sendMessage(
  session: AgentSessionState,
  request: SendMessageRequest,
  signal?: AbortSignal,
): Promise<void> {
  if (!session.client || !session.sessionId) {
    throw new Error("유효하지 않은 세션");
  }

  const state = getOrInitState();
  const sessionId = session.sessionId;

  // 프롬프트 조립 — fleet-core가 firstPromptSent 분기 + runtime context wrapping 자체 처리
  const prompt = session.firstPromptSent
    ? buildRuntimeContextPrompt(request.userRequest)
    : buildInitialPrompt(request.history ?? [], request.userRequest);

  // 이벤트 emitter 연결
  const piToolNames = getSessionToolNames(session);
  const removeListeners = wireStreamEmitter(session.client, sessionId, piToolNames);

  // abort 핸들링 — cancelPrompt만 호출, 세션은 유지
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    debug("abort 신호 수신");
    session.client?.cancelPrompt().catch(() => {});
    closeLogicalPromptRouting(state, session);
    emitStreamEvent({ type: "error", sessionId, error: "Operation aborted" });
    removeListeners();
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  // MCP tool call notifier — emit 이벤트
  if (session.mcpSessionToken) {
    session.pendingToolCallNotifier = () => {
      emitNextPendingToolCall(session, (toolName, args, toolCallId) => {
        emitStreamEvent({ type: "mcpToolCall", sessionId, toolCallId, name: toolName, args });
        // round-trip 가드 플래그 — deliverToolResults가 이 플래그로 세션 유효성 판정
        if (session.activePrompt) session.activePrompt.mcpToolUseStarted = true;
        // done:"toolUse" emit → 호출자가 toolResult 전달
        emitStreamEvent({ type: "complete", sessionId, done: "toolUse" });
        return true;
      });
    };
  }

  // active prompt 추적
  const promptId = crypto.randomUUID();
  const promptGeneration = session.sessionGeneration;
  session.activePrompt = {
    promptId,
    sessionGeneration: promptGeneration,
    retryConsumed: false,
    assistantOutputStarted: false,
    builtinToolStarted: false,
    mcpToolUseStarted: false,
  };
  session.lastError = null;

  // sendMessage — promptComplete까지 resolve 대기
  debug(`sendMessage: promptLen=${prompt.length} firstPrompt=${!session.firstPromptSent}`);
  try {
    await session.client.sendMessage(prompt);
  } catch (err) {
    if (aborted) return;
    const msg = errorMessage(err);
    debug(`sendMessage 에러: ${msg}`);
    session.lastError = msg;
    session.needsRecovery = isRecoverablePromptFailure(err);
    emitStreamEvent({ type: "error", sessionId, error: msg });
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    removeListeners();
    if (session.pendingToolCallNotifier) {
      session.pendingToolCallNotifier = null;
    }
    if (session.activePrompt?.promptId === promptId) {
      session.firstPromptSent = true;
    }
  }
}

/** toolResult 전달 — FIFO resolve 후 이벤트 스트림 재개 */
export async function deliverToolResults(
  session: AgentSessionState,
  toolResults: ToolResultEnvelope[],
  signal?: AbortSignal,
): Promise<void> {
  const state = getOrInitState();

  if (!session?.client || !session.sessionId || !session.mcpSessionToken) {
    emitStreamEvent({ type: "error", sessionId: session.sessionId ?? "", error: "tool result delivery: 세션이 유효하지 않습니다" });
    clearSessionRoutingState(state, session);
    return;
  }

  if (session.needsRecovery || !session.activePrompt || session.activePrompt.mcpToolUseStarted !== true) {
    emitStreamEvent({ type: "error", sessionId: session.sessionId, error: "이전 toolUse 이후 세션이 유효하지 않습니다" });
    closeLogicalPromptRouting(state, session);
    return;
  }

  debug("tool result delivery");

  // FIFO resolve
  for (const result of toolResults) {
    const head = getPendingToolCallHead(session);
    if (!result.toolCallId || head?.toolCallId !== result.toolCallId) {
      throw new Error("toolResult의 toolCallId가 현재 ACP 세션의 FIFO head와 일치하지 않습니다");
    }
    const mcpResult = convertToMcpResult(result);
    resolveToolResult(session, result.toolCallId, mcpResult);
    consumePendingToolCall(state, session, result.toolCallId);
    debug(`tool result → MCP resolve 완료`);
  }

  // 이벤트 스트림 — 첫 sendMessage의 wireStreamEmitter listener가 살아있으므로
  // 여기서 재등록하면 messageChunk가 중복 emit된다(같은 chunk N개 listener × N개 emit).
  // deliverToolResults는 resolveToolResult로 ACP에 회신만 하고, 응답 chunk는
  // 첫 sendMessage가 등록한 기존 listener가 처리하도록 둔다.
  const sessionId = session.sessionId;

  // abort
  const onAbort = (): void => {
    session.client?.cancelPrompt().catch(() => {});
    closeLogicalPromptRouting(state, session);
    emitStreamEvent({ type: "error", sessionId, error: "Operation aborted" });
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  // MCP tool call notifier — chained tool call 흐름
  if (session.mcpSessionToken) {
    session.pendingToolCallNotifier = () => {
      emitNextPendingToolCall(session, (toolName, args, toolCallId) => {
        emitStreamEvent({ type: "mcpToolCall", sessionId, toolCallId, name: toolName, args });
        // round-trip 가드 플래그 — deliverToolResults가 이 플래그로 세션 유효성 판정
        if (session.activePrompt) session.activePrompt.mcpToolUseStarted = true;
        emitStreamEvent({ type: "complete", sessionId, done: "toolUse" });
        return true;
      });
    };
  }

  // 첫 대기 중인 tool call emit
  emitNextPendingToolCall(session, (toolName, args, toolCallId) => {
    emitStreamEvent({ type: "mcpToolCall", sessionId, toolCallId, name: toolName, args });
    // round-trip 가드 플래그 — deliverToolResults가 이 플래그로 세션 유효성 판정
    if (session.activePrompt) session.activePrompt.mcpToolUseStarted = true;
    emitStreamEvent({ type: "complete", sessionId, done: "toolUse" });
    return true;
  });
}

/** 세션, MCP, 브릿지 상태 일괄 정리 */
export async function clearSessionsAndPreSpawn(state: AgentProviderState): Promise<void> {
  for (const session of state.sessions.values()) {
    clearSessionRoutingState(state, session);
    await disconnectSession(session);
    for (const [scopeName, mappedSessionKey] of state.bridgeScopeSessionKeys.entries()) {
      if (mappedSessionKey === session.sessionKey) {
        state.bridgeScopeSessionKeys.delete(scopeName);
      }
    }
    state.sessionLaunchConfigs.delete(session.sessionKey);
  }
  state.sessions.clear();
  state.sessionKeysByScope.clear();
  state.toolCallToSessionKey.clear();
  state.bridgeScopeSessionKeys.clear();
  state.sessionLaunchConfigs.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════════

function debug(...args: unknown[]): void {
  const log = getLogAPI();
  log.debug("acp-provider", args.map(String).join(" "), { category: "acp" });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    try { return JSON.stringify(err); } catch { /* noop */ }
  }
  return String(err);
}

function isRecoverablePromptFailure(err: unknown): boolean {
  const message = errorMessage(err);
  return isDeadSessionError(err) ||
    TRANSPORT_RECOVERY_PATTERNS.some((pattern) => pattern.test(message));
}

function isProviderClientAlive(client: IUnifiedAgentClient): boolean {
  const info = client.getConnectionInfo();
  return info.state === "ready" || info.state === "connected";
}

function getSessionKey(cli: CliType, scopeKey: string): string {
  return `${SESSION_KEY_PREFIX}:${cli}:${scopeKey}`;
}

function getHostSessionStoreKey(cli: CliType, _scopeKey: string): string {
  return `host:${cli}`;
}

function getSessionByScope(
  state: AgentProviderState,
  cli: CliType,
  scopeKey: string,
): AgentSessionState | undefined {
  const sessionKey = getSessionKey(cli, scopeKey);
  const session = state.sessions.get(sessionKey);
  if (!session) return undefined;
  return session.cli === cli ? session : undefined;
}

function registerSession(
  state: AgentProviderState,
  session: AgentSessionState,
): void {
  state.sessions.set(session.sessionKey, session);
  let scopeSessions = state.sessionKeysByScope.get(session.scopeKey);
  if (!scopeSessions) {
    scopeSessions = new Set();
    state.sessionKeysByScope.set(session.scopeKey, scopeSessions);
  }
  scopeSessions.add(session.sessionKey);
}

function removeSession(
  state: AgentProviderState,
  session: AgentSessionState,
): void {
  clearSessionRoutingState(state, session);
  for (const [scopeName, mappedSessionKey] of state.bridgeScopeSessionKeys.entries()) {
    if (mappedSessionKey === session.sessionKey) {
      state.bridgeScopeSessionKeys.delete(scopeName);
    }
  }
  state.sessionLaunchConfigs.delete(session.sessionKey);
  const scopeSessions = state.sessionKeysByScope.get(session.scopeKey);
  scopeSessions?.delete(session.sessionKey);
  if (scopeSessions && scopeSessions.size === 0) {
    state.sessionKeysByScope.delete(session.scopeKey);
  }
  state.sessions.delete(session.sessionKey);
}

async function buildConnectOptions(
  cli: CliType,
  cwd: string,
  backendModel: string,
  systemPrompt?: string,
  mcpServers?: McpServerConfig[],
  sessionId?: string,
): Promise<UnifiedClientOptions> {
  const connectOptions: UnifiedClientOptions = {
    cwd,
    cli,
    model: backendModel,
    autoApprove: true,
    clientInfo: { name: "pi-unified-agent-provider", version: "1.0.0" },
    timeout: 0,
    yoloMode: true,
    promptIdleTimeout: DEFAULT_PROMPT_IDLE_TIMEOUT,
  };

  const env = await resolveAuthEnv(cli);
  if (Object.keys(env).length > 0) {
    connectOptions.env = env;
  }

  if (systemPrompt) {
    connectOptions.systemPrompt = systemPrompt;
  }

  if (mcpServers) {
    connectOptions.mcpServers = mcpServers;
  }

  if (sessionId) {
    connectOptions.sessionId = sessionId;
  }

  return connectOptions;
}

async function applyPostConnectConfig(
  client: Pick<IUnifiedAgentClient, "setConfigOption">,
  cli: CliType,
  overrides?: { effort?: string },
): Promise<void> {
  if (overrides?.effort && getReasoningEffortLevels(cli)) {
    try {
      await client.setConfigOption("reasoning_effort", overrides.effort);
    } catch (err) {
      console.warn(`[acp] setConfigOption 실패 (cli=${cli}, option=reasoning_effort)`, err);
    }
  }
}

function formatSessionPrefix(sessionId: string): string {
  if (sessionId === "unknown") return sessionId;
  return `${sessionId.slice(0, 8)}...`;
}

function buildAllMcpTools(): McpTool[] {
  return list().map(metadataToMcpTool);
}

/**
 * 첫 프롬프트용 XML 구조화 프롬프트 — 대화 히스토리 + buildRuntimeContextPrompt 래핑.
 * conversation-history XML + buildRuntimeContextPrompt(userRequest)를 조립.
 */
function buildInitialPrompt(
  history: readonly ConversationHistoryEntry[],
  userRequest: string,
): string {
  const parts: string[] = [];

  if (history.length > 0) {
    const historyParts = history
      .filter((entry) => entry.text)
      .map((entry) => `<message role="${entry.role}">\n${entry.text}\n</message>`);
    if (historyParts.length > 0) {
      parts.push(`<conversation-history>\n${historyParts.join("\n")}\n</conversation-history>`);
    }
  }

  parts.push(buildRuntimeContextPrompt(userRequest));

  return parts.join("\n\n");
}

function computeToolHash(tools: McpTool[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const str = JSON.stringify(sorted.map((t) => ({ n: t.name, p: t.parameters })));
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

function convertToMcpResult(result: ToolResultEnvelope): { content: Array<{ type: string; text?: string }>; isError: boolean } {
  const mcpResult: { content: Array<{ type: string; text?: string }>; isError: boolean } = {
    content: [],
    isError: result.isError ?? false,
  };

  if (typeof result.content === "string") {
    mcpResult.content.push({ type: "text", text: result.content });
  } else if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === "text") {
        mcpResult.content.push({ type: "text", text: block.text ?? "" });
      }
    }
  }
  if (mcpResult.content.length === 0) {
    mcpResult.content.push({ type: "text", text: "(결과 없음)" });
  }

  return mcpResult;
}

async function getMcpUrl(): Promise<string> {
  // MCP URL은 fleet-services의 cachedMcpUrlPromise를 통해 확보
  // 내부 모듈이므로 직접 mcp.ts의 startMcpServer를 호출
  const { startMcpServer } = await import("../../_shared/mcp.js");
  return startMcpServer();
}
