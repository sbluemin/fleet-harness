/**
 * admiral/agent/internal/executor-engine — 풀 기반 executor 구현체.
 *
 * carrier-agnostic 일반 executor. poolKey로 식별자를 일반화.
 * globalThis 대신 모듈 레벨 Map 사용.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  UnifiedAgent,
  getEffort,
  getProviderModels,
  type AcpToolCall,
  type AcpToolCallUpdate,
  type CliType,
  type ConnectResult,
  type IUnifiedAgentClient,
  type McpServerConfig,
  type UnifiedAgentBuildOptions,
  type UnifiedClientOptions,
} from "@dotobokuri/fleet-unified-agent";

import {
  cleanupExecutorSession as cleanupExecutorMcpSession,
  convertToolSchema,
  detachExecutorMcpForReuse as detachExecutorMcpForSessionReuse,
  installExecutorToolCallRouter,
  registerExecutorSessionTools,
  type AgentToolSpec,
  type McpRouterRuntime,
} from "@dotobokuri/fleet-mcp-server";

import { executorPortRuntime } from "../executor-port.js";
import { resolveBuiltinExternalMcpServers } from "../external-mcp.js";
import type { TrackStatus } from "../types.js";
import { resolveAuthEnv } from "../../auth/index.js";
import { getLogAPI } from "../../log/index.js";
import { classifyResumeFailure } from "./session-errors.js";
import { applyPostConnectConfig } from "./post-connect.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export interface ExecuteOptions {
  poolKey: string;
  carrierId?: string;
  cliType: CliType;
  request: string;
  cwd: string;
  model?: string;
  effort?: string;
  promptIdleTimeout?: number;
  connectSystemPrompt?: string | null;
  signal?: AbortSignal;
  onMessageChunk?: (text: string) => void;
  onThoughtChunk?: (text: string) => void;
  onToolCall?: (title: string, status: string, rawOutput?: string, toolCallId?: string) => void;
  onConnected?: (info: { sessionId?: string; model?: string }) => void;
  onStatusChange?: (status: TrackStatus) => void;
}

export type ExecResult = {
  responseText: string;
  thoughtText: string;
  toolCalls: { title: string; status: string; rawOutput?: string; toolCallId?: string }[];
  status: TrackStatus;
  error?: string;
  sessionId?: string;
};

interface PooledClient {
  client: IUnifiedAgentClient;
  busy: boolean;
  sessionId?: string;
  mcpSessionTokens?: readonly ExecutorMcpSessionToken[];
  builtinExternalMcpSignature?: string;
  internalExecutorMcpSignature?: string;
}

interface LaunchConfig {
  readonly model?: string;
  readonly effort?: string;
}

type ToolCallLike = (AcpToolCall | AcpToolCallUpdate) & {
  content?: unknown;
  rawOutput?: unknown;
  toolCallId?: string;
};

export interface ExecutorMcpSessionToken {
  readonly serverName: string;
  readonly token: string;
}

interface ExecutorMcpSetup {
  readonly tokens: readonly ExecutorMcpSessionToken[];
  readonly mcpServers: McpServerConfig[];
}

type EffortResolution =
  | { readonly kind: "explicit"; readonly effort: string }
  | { readonly kind: "default"; readonly effort: string }
  | { readonly kind: "fallback"; readonly effort: string }
  | { readonly kind: "clear"; readonly effort?: undefined }
  | { readonly kind: "unspecified"; readonly effort?: undefined };

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const CLIENT_INFO = { name: "fleet-unified-agent", version: "1.0.0" } as const;
const MAX_TOOL_CALLS_TO_KEEP = 30;
const INTERNAL_MCP_SERVER_NAMES = new Set(["fleet-carriers", "fleet-wiki"]);

// ═══════════════════════════════════════════════════════════════════════════
// Module-level pool (globalThis 대체)
// ═══════════════════════════════════════════════════════════════════════════

const clientPool = new Map<string, PooledClient[]>();
const launchConfigs = new Map<string, LaunchConfig>();

function getMcpRouterRuntime(serverName: string): McpRouterRuntime | undefined {
  return executorPortRuntime.getExecutorMcpRouterRuntimes()
    .find((entry) => entry.name === serverName)?.runtime;
}

function cleanupExecutorSessions(sessionTokens: readonly ExecutorMcpSessionToken[]): void {
  for (const { serverName, token } of sessionTokens) {
    const runtime = getMcpRouterRuntime(serverName);
    if (runtime) cleanupExecutorMcpSession(runtime, token);
  }
}

function detachExecutorMcpForReuse(sessionTokens: readonly ExecutorMcpSessionToken[]): void {
  for (const { serverName, token } of sessionTokens) {
    const runtime = getMcpRouterRuntime(serverName);
    if (runtime) detachExecutorMcpForSessionReuse(runtime, token);
  }
}

function installActiveExecutorToolCallRouter(
  sessionTokens: readonly ExecutorMcpSessionToken[],
  ctx: { cwd: string; signal?: AbortSignal },
): void {
  for (const { serverName, token } of sessionTokens) {
    const runtime = getMcpRouterRuntime(serverName);
    if (runtime) installExecutorToolCallRouter(runtime, token, ctx);
  }
}

function registerActiveExecutorSessionTools(
  runtime: McpRouterRuntime,
  sessionToken: string,
  specs: AgentToolSpec[],
): void {
  registerExecutorSessionTools(runtime, sessionToken, specs);
}

// ═══════════════════════════════════════════════════════════════════════════
// Functions (공개 — executor.ts facade에서 호출)
// ═══════════════════════════════════════════════════════════════════════════

export async function engineExecuteWithPool(opts: ExecuteOptions): Promise<ExecResult> {
  const { poolKey, carrierId, cliType, request, cwd, signal } = opts;
  const builtinExternalMcpSignature = buildBuiltinExternalMcpSignature(carrierId);
  const internalExecutorMcpSignature = buildInternalExecutorMcpSignature(carrierId);

  let responseText = "";
  let thoughtText = "";
  const toolCalls: ExecResult["toolCalls"] = [];
  let status: TrackStatus = "conn";
  let error: string | undefined;
  let aborted = false;
  let isLivePrompt = false;
  let promptHandedOff = false;
  let sessionId: string | undefined;
  let activeMcpTokens: readonly ExecutorMcpSessionToken[] | undefined;

  opts.onStatusChange?.("conn");

  const entries = clientPool.get(poolKey) ?? [];
  let poolEntry: PooledClient | undefined;
  let reconnectSessionId: string | undefined;

  // 기존 entries에서 사용 가능한 entry를 찾고, dead/drifted entry는 정리한다.
  const retained: PooledClient[] = [];
  for (const entry of entries) {
    if (entry.busy) {
      retained.push(entry);
      continue;
    }
    if (!isClientAlive(entry.client)) {
      reconnectSessionId = entry.sessionId ?? reconnectSessionId;
      if (entry.mcpSessionTokens) {
        cleanupExecutorSessions(entry.mcpSessionTokens);
      }
      entry.client.removeAllListeners();
      continue;
    }
    if (entry.builtinExternalMcpSignature !== builtinExternalMcpSignature) {
      await discardSingleEntry(entry);
      continue;
    }
    if (entry.internalExecutorMcpSignature !== internalExecutorMcpSignature) {
      await discardSingleEntry(entry);
      continue;
    }
    if (hasSystemPromptDrift(entry.client, opts.connectSystemPrompt ?? null)) {
      debugSystemPromptDrift("executeWithPool", poolKey, cliType);
      await discardSingleEntry(entry);
      continue;
    }
    if (!poolEntry) {
      poolEntry = entry;
    }
    retained.push(entry);
  }

  let client: IUnifiedAgentClient;

  if (poolEntry) {
    client = poolEntry.client;
    poolEntry.busy = true;
    // retained 배열에 이미 포함된 상태
  } else {
    client = await buildProviderClient({ cli: cliType });
    poolEntry = {
      client,
      busy: true,
      sessionId: reconnectSessionId,
      builtinExternalMcpSignature,
      internalExecutorMcpSignature,
    };
    retained.push(poolEntry);
    client.on("exit", () => {
      removeEntryFromPool(poolKey, client);
    });
  }

  if (retained.length === 0) {
    clientPool.delete(poolKey);
  } else {
    clientPool.set(poolKey, retained);
  }

  let detachStderr = attachStderrLogging(client, `acp-exec:${poolKey}`);

  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    status = "aborted";
    opts.onStatusChange?.("aborted");
    void Promise.allSettled([
      client.cancelPrompt(),
      removeAndDisconnectEntry(poolKey, client),
    ]);
  };

  if (signal?.aborted) {
    detachStderr();
    if (poolEntry) poolEntry.busy = false;
    return { responseText: "", thoughtText: "", toolCalls: [], status: "aborted" };
  }

  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  const onMessageChunk = (text: string) => {
    if (!isLivePrompt) return;
    responseText += text;
    opts.onMessageChunk?.(text);
  };
  const onThoughtChunk = (text: string) => {
    if (!isLivePrompt) return;
    thoughtText += text;
    opts.onThoughtChunk?.(text);
  };
  const upsertToolCall = (title: string, tcStatus: string, rawOutput?: string, toolCallId?: string) => {
    if (!isLivePrompt) return;
    const existing = toolCalls.find((tc) =>
      toolCallId ? tc.toolCallId === toolCallId : tc.title === title,
    );
    const isFirstPush = !existing;
    if (existing) {
      // ACP 분할 도착: 후속 tool_call_update의 풍부한 title이 1차 빈약 title을 덮도록.
      // 빈 값이 기존 값을 지우는 것은 방지.
      if (title) existing.title = title;
      if (tcStatus) existing.status = tcStatus;
      if (rawOutput !== undefined) existing.rawOutput = rawOutput;
    } else {
      toolCalls.push({ title, status: tcStatus, rawOutput, toolCallId });
    }
    if (toolCalls.length > MAX_TOOL_CALLS_TO_KEEP) toolCalls.splice(0, toolCalls.length - MAX_TOOL_CALLS_TO_KEEP);
    // ACP 분할 도착 UX 개선: 1차 빈약 toolCall(status=pending)은 외부 callback emit 보류.
    // 풍부 title이 도착하는 후속 update에서 첫 effective emit 발생 → panel/host UI 깜빡임 방지.
    if (isFirstPush && tcStatus === "pending") return;
    // 후속 update의 빈 title/status는 머지된 latest 값으로 복원해서 callback에 전달.
    // 그러지 않으면 sanitizeToolLabel("")이 "(unnamed)"로 변환되어 풍부 title을 덮어쓰는 회귀 발생.
    const merged = existing ?? toolCalls[toolCalls.length - 1];
    const effectiveTitle = title || merged?.title || "";
    const effectiveStatus = tcStatus || merged?.status || "";
    opts.onToolCall?.(effectiveTitle, effectiveStatus, rawOutput, toolCallId);
  };
  const onToolCall = (title: string, tcStatus: string, _sid: string, data?: AcpToolCall) => {
    upsertToolCall(enrichToolTitle(title, data?.kind), tcStatus, extractToolResultText(data as ToolCallLike | undefined), data?.toolCallId);
  };
  const onToolCallUpdate = (title: string, tcStatus: string, _sid: string, data?: AcpToolCallUpdate) => {
    upsertToolCall(enrichToolTitle(title, data?.kind ?? undefined), tcStatus, extractToolResultText(data as ToolCallLike | undefined), data?.toolCallId);
  };
  const onError = (err: Error) => {
    if (!aborted) error = err.message;
  };

  const attachListeners = () => {
    client.on("messageChunk", onMessageChunk);
    client.on("thoughtChunk", onThoughtChunk);
    client.on("toolCall", onToolCall);
    client.on("toolCallUpdate", onToolCallUpdate);
    client.on("error", onError);
  };
  const detachListeners = () => {
    client.off("messageChunk", onMessageChunk);
    client.off("thoughtChunk", onThoughtChunk);
    client.off("toolCall", onToolCall);
    client.off("toolCallUpdate", onToolCallUpdate);
    client.off("error", onError);
  };

  attachListeners();

  try {
    let needsConnect = !isClientAlive(client);

    if (needsConnect) {
      const mcpSetup = await setupExecutorMcp(cwd, signal, carrierId);
      if (mcpSetup?.tokens) activeMcpTokens = mcpSetup.tokens;
      const model = resolveModel(poolKey, cliType, opts.model);
      const effortResolution = resolveEffort(poolKey, cliType, model, opts.model, opts.effort);

      const connectOpts = await buildConnectOptions(cliType, cwd, {
        model: opts.model,
        promptIdleTimeout: opts.promptIdleTimeout,
        effort: effortResolution.effort,
      }, opts.connectSystemPrompt ?? null, mcpSetup?.mcpServers);

      const savedSessionId = poolEntry?.sessionId ?? reconnectSessionId;
      if (savedSessionId) connectOpts.sessionId = savedSessionId;

      let connectResult: ConnectResult;
      try {
        connectResult = await raceAbort(client.connect(connectOpts), signal);
      } catch (connectError) {
        if (aborted) throw connectError;
        if (!savedSessionId) throw connectError;
        if (classifyResumeFailure(connectError) !== "dead-session") throw connectError;

        console.error(
          `[unified-agent] session/load 실패 (key=${poolKey}, sessionId=${savedSessionId}):`,
          connectError instanceof Error ? connectError.message : connectError,
        );

        if (poolEntry) delete poolEntry.sessionId;
        delete connectOpts.sessionId;

        // dead-session MCP 토큰 rotate — 구 토큰 정리 후 재발급
        if (activeMcpTokens) {
          cleanupExecutorSessions(activeMcpTokens);
          activeMcpTokens = undefined;
        }

        try { await client.disconnect(); } catch { }
        detachListeners();
        detachStderr();
        client = await buildProviderClient({ cli: cliType });
        detachStderr = attachStderrLogging(client, `acp-exec:${poolKey}`);
        replaceEntryClient(poolKey, poolEntry!, client, builtinExternalMcpSignature, internalExecutorMcpSignature);
        attachListeners();

        const retryMcpSetup = await setupExecutorMcp(cwd, signal, carrierId);
        if (retryMcpSetup) {
          activeMcpTokens = retryMcpSetup.tokens;
          connectOpts.mcpServers = retryMcpSetup.mcpServers;
        } else {
          delete connectOpts.mcpServers;
        }

        connectResult = await raceAbort(client.connect(connectOpts), signal);
      }

      sessionId = connectResult.session?.sessionId ?? undefined;

      if (sessionId && poolEntry) {
        poolEntry.sessionId = sessionId;
      }

      if (activeMcpTokens) {
        if (poolEntry) poolEntry.mcpSessionTokens = activeMcpTokens;
        installActiveExecutorToolCallRouter(activeMcpTokens, { cwd, signal });
      }

      const effortApplied = await applyResolvedEffort(client, cliType, model, effortResolution);
      setLaunchConfig(poolKey, model, getStoredEffort(effortResolution, effortApplied));
    } else {
      const info = client.getConnectionInfo();
      sessionId = info.sessionId ?? undefined;

      if (sessionId && poolEntry) {
        poolEntry.sessionId = sessionId;
      }

      const model = resolveModel(poolKey, cliType, opts.model);
      const effortResolution = resolveEffort(poolKey, cliType, model, opts.model, opts.effort);
      const effortApplied = await applyResolvedEffort(client, cliType, model, effortResolution);
      setLaunchConfig(poolKey, model, getStoredEffort(effortResolution, effortApplied));

      if (poolEntry?.mcpSessionTokens) {
        activeMcpTokens = poolEntry.mcpSessionTokens;
        installActiveExecutorToolCallRouter(activeMcpTokens, { cwd, signal });
      }
    }

    if (aborted) {
      return { responseText, thoughtText, toolCalls, status, error, sessionId };
    }

    opts.onConnected?.({ sessionId, model: undefined });
    status = "stream";
    opts.onStatusChange?.("stream");

    responseText = "";
    thoughtText = "";
    toolCalls.length = 0;
    isLivePrompt = true;

    promptHandedOff = true;
    await client.sendMessage(request);

    const postSendInfo = client.getConnectionInfo();
    if (postSendInfo.sessionId && postSendInfo.sessionId !== sessionId) {
      sessionId = postSendInfo.sessionId;
    }
    if (sessionId && poolEntry) {
      poolEntry.sessionId = sessionId;
    }

    if (!aborted) {
      status = "done";
      if (!responseText.trim()) responseText = "(no output)";
      opts.onStatusChange?.("done");
    }
  } catch (err) {
    if (!aborted) {
      status = "err";
      error = err instanceof Error ? err.message : String(err);
      if (!responseText) responseText = error;
      opts.onStatusChange?.("err");
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    detachListeners();
    detachStderr();
    if (poolEntry) poolEntry.busy = false;

    if (promptHandedOff) {
      const finalSessionId = client.getConnectionInfo().sessionId ?? sessionId;
      if (finalSessionId) {
        sessionId = finalSessionId;
        if (poolEntry) poolEntry.sessionId = finalSessionId;
      }
    }

    if (activeMcpTokens) {
      if (poolEntry?.mcpSessionTokens === activeMcpTokens) {
        detachExecutorMcpForReuse(activeMcpTokens);
      } else {
        cleanupExecutorSessions(activeMcpTokens);
      }
    }
  }

  return { responseText, thoughtText, toolCalls, status, error, sessionId };
}

export async function engineExecuteOneShot(opts: ExecuteOptions): Promise<ExecResult> {
  const { poolKey, carrierId, cliType, request, cwd, signal } = opts;

  let responseText = "";
  let thoughtText = "";
  const toolCalls: ExecResult["toolCalls"] = [];
  let status: TrackStatus = "conn";
  let error: string | undefined;
  let sessionId: string | undefined;

  opts.onStatusChange?.("conn");

  const client = await buildProviderClient({ cli: cliType });
  const detachStderr = attachStderrLogging(client, `acp-exec:${poolKey}`);
  let aborted = false;
  let activeMcpTokens: readonly ExecutorMcpSessionToken[] | undefined;

  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    status = "aborted";
    opts.onStatusChange?.("aborted");
    void Promise.allSettled([client.cancelPrompt(), client.disconnect()]);
  };

  try {
    if (signal?.aborted) {
      return { responseText: "", thoughtText: "", toolCalls: [], status: "aborted" };
    }

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const mcpSetup = await setupExecutorMcp(cwd, signal, carrierId);
    if (mcpSetup) activeMcpTokens = mcpSetup.tokens;
    const model = resolveModel(poolKey, cliType, opts.model);
    const effortResolution = resolveEffort(poolKey, cliType, model, opts.model, opts.effort);

    const connectOpts = await buildConnectOptions(cliType, cwd, {
      model: opts.model,
      promptIdleTimeout: opts.promptIdleTimeout,
      effort: effortResolution.effort,
    }, opts.connectSystemPrompt ?? null, mcpSetup?.mcpServers);

    const connectResult = await raceAbort(client.connect(connectOpts), signal);
    await applyResolvedEffort(client, cliType, model, effortResolution);

    if (activeMcpTokens) {
      installActiveExecutorToolCallRouter(activeMcpTokens, { cwd, signal });
    }

    if (aborted) {
      return { responseText, thoughtText, toolCalls, status, error, sessionId };
    }

    sessionId = connectResult.session?.sessionId ?? undefined;

    opts.onConnected?.({ sessionId });
    status = "stream";
    opts.onStatusChange?.("stream");

    client.on("messageChunk", (text: string) => {
      responseText += text;
      opts.onMessageChunk?.(text);
    });
    client.on("thoughtChunk", (text: string) => {
      thoughtText += text;
      opts.onThoughtChunk?.(text);
    });
    const upsertToolCall = (title: string, tcStatus: string, rawOutput?: string, toolCallId?: string) => {
      const existing = toolCalls.find((tc) =>
        toolCallId ? tc.toolCallId === toolCallId : tc.title === title,
      );
      if (existing) {
        existing.status = tcStatus;
        if (rawOutput !== undefined) existing.rawOutput = rawOutput;
      } else {
        toolCalls.push({ title, status: tcStatus, rawOutput, toolCallId });
      }
      opts.onToolCall?.(title, tcStatus, rawOutput, toolCallId);
    };
    client.on("toolCall", (title: string, tcStatus: string, _sid: string, data?: AcpToolCall) => {
      upsertToolCall(title, tcStatus, extractToolResultText(data as ToolCallLike | undefined), data?.toolCallId);
    });
    client.on("toolCallUpdate", (title: string, tcStatus: string, _sid: string, data?: AcpToolCallUpdate) => {
      upsertToolCall(title, tcStatus, extractToolResultText(data as ToolCallLike | undefined), data?.toolCallId);
    });

    await client.sendMessage(request);

    if (!aborted) {
      status = "done";
      if (!responseText.trim()) responseText = "(no output)";
      opts.onStatusChange?.("done");
    }
  } catch (e) {
    if (!aborted) {
      status = "err";
      error = e instanceof Error ? e.message : String(e);
      if (!responseText) responseText = `Error: ${error}`;
      opts.onStatusChange?.("err");
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    detachStderr();
    if (activeMcpTokens) {
      cleanupExecutorSessions(activeMcpTokens);
      activeMcpTokens = undefined;
    }
    try { await client.disconnect(); } catch { /* 정리 실패 무시 */ }
    client.removeAllListeners();
  }

  return { responseText, thoughtText, toolCalls, status, error, sessionId };
}

/** connections.ts에서 호출 — 특정 풀 키의 모든 엔트리 종료 */
export async function engineDisconnect(poolKey: string): Promise<boolean> {
  const entries = clientPool.get(poolKey);
  if (!entries || entries.length === 0) return false;
  clientPool.delete(poolKey);
  const promises: Promise<void>[] = [];
  for (const entry of entries) {
    entry.busy = false;
    if (entry.mcpSessionTokens) {
      cleanupExecutorSessions(entry.mcpSessionTokens);
      entry.mcpSessionTokens = undefined;
    }
    promises.push(entry.client.disconnect().catch(() => { }));
    entry.client.removeAllListeners();
  }
  await Promise.allSettled(promises);
  return true;
}

/** connections.ts에서 호출 — 전체 풀 정리 */
export async function engineDisconnectAll(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [, entries] of clientPool) {
    for (const entry of entries) {
      if (entry.mcpSessionTokens) {
        cleanupExecutorSessions(entry.mcpSessionTokens);
        entry.mcpSessionTokens = undefined;
      }
      promises.push(entry.client.disconnect().catch(() => { }));
    }
  }
  await Promise.allSettled(promises);
  clientPool.clear();
  launchConfigs.clear();
}

/** connections.ts에서 호출 — busy가 아닌 클라이언트 정리 (풀 축소) */
export function engineCleanIdle(): void {
  for (const [key, entries] of clientPool) {
    const active = entries.filter((entry) => {
      if (entry.busy) return true;
      if (entry.mcpSessionTokens) {
        cleanupExecutorSessions(entry.mcpSessionTokens);
        entry.mcpSessionTokens = undefined;
      }
      entry.client.disconnect().catch(() => { });
      entry.client.removeAllListeners();
      return false;
    });
    if (active.length === 0) {
      clientPool.delete(key);
    } else {
      clientPool.set(key, active);
    }
  }
}

/** connections.ts에서 호출 — 살아 있는 풀 엔트리의 sessionId 조회 */
export function engineGetPooledSessionId(poolKey: string): string | undefined {
  const entries = clientPool.get(poolKey);
  if (!entries || entries.length === 0) return undefined;
  for (const entry of entries) {
    if (!isClientAlive(entry.client)) {
      if (entry.busy) continue;
      continue;
    }
    if (entry.sessionId) return entry.sessionId;
  }
  // 살아 있는 entry가 없으면 dead non-busy entries 정리
  const alive = entries.filter((entry) => {
    if (entry.busy) return true;
    if (!isClientAlive(entry.client)) {
      if (entry.mcpSessionTokens) {
        cleanupExecutorSessions(entry.mcpSessionTokens);
      }
      entry.client.removeAllListeners();
      return false;
    }
    return true;
  });
  if (alive.length === 0) {
    clientPool.delete(poolKey);
  } else if (alive.length !== entries.length) {
    clientPool.set(poolKey, alive);
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════════

function resolveEffort(
  poolKey: string,
  cliType: CliType,
  model: string,
  modelOverride: string | undefined,
  effortOverride: string | undefined,
): EffortResolution {
  if (effortOverride) {
    return { kind: "explicit", effort: effortOverride };
  }

  const launchConfig = launchConfigs.get(poolKey);
  const modelChanged = modelOverride !== undefined &&
    launchConfig?.model !== undefined &&
    launchConfig.model !== model;

  if (!modelChanged) {
    return launchConfig?.effort
      ? { kind: "fallback", effort: launchConfig.effort }
      : { kind: "unspecified" };
  }

  const modelEffort = getEffort(cliType, model);
  return modelEffort.supported
    ? { kind: "default", effort: modelEffort.default }
    : { kind: "clear" };
}

function resolveModel(poolKey: string, cliType: CliType, override?: string): string {
  return override ?? launchConfigs.get(poolKey)?.model ?? getProviderModels(cliType).defaultModel;
}

async function applyResolvedEffort(
  client: IUnifiedAgentClient,
  cliType: CliType,
  model: string,
  resolution: EffortResolution,
): Promise<boolean> {
  if (resolution.kind === "clear" || resolution.kind === "unspecified") {
    return false;
  }
  return applyPostConnectConfig(client, cliType, model, { effort: resolution.effort });
}

function getStoredEffort(
  resolution: EffortResolution,
  applied: boolean,
): string | null | undefined {
  if (resolution.kind === "clear") {
    return null;
  }
  if (resolution.kind === "unspecified") {
    return undefined;
  }
  return applied ? resolution.effort : null;
}

function setLaunchConfig(poolKey: string, model: string, effort: string | null | undefined): void {
  const previous = launchConfigs.get(poolKey);
  const next: { model: string; effort?: string } = { ...previous, model };
  if (effort === null) {
    delete next.effort;
  } else if (effort !== undefined) {
    next.effort = effort;
  }
  launchConfigs.set(poolKey, next);
}

async function discardSingleEntry(entry: PooledClient): Promise<void> {
  entry.busy = false;
  if (entry.mcpSessionTokens) {
    cleanupExecutorSessions(entry.mcpSessionTokens);
    entry.mcpSessionTokens = undefined;
  }
  delete entry.sessionId;
  try { await entry.client.disconnect(); } catch { /* 정리 실패 무시 */ }
  entry.client.removeAllListeners();
}

function removeEntryFromPool(poolKey: string, client: IUnifiedAgentClient): void {
  const entries = clientPool.get(poolKey);
  if (!entries) return;
  const idx = entries.findIndex((e) => e.client === client);
  if (idx < 0) return;
  const entry = entries[idx]!;
  if (entry.mcpSessionTokens) {
    cleanupExecutorSessions(entry.mcpSessionTokens);
    entry.mcpSessionTokens = undefined;
  }
  entries.splice(idx, 1);
  if (entries.length === 0) clientPool.delete(poolKey);
}

async function removeAndDisconnectEntry(poolKey: string, client: IUnifiedAgentClient): Promise<void> {
  const entries = clientPool.get(poolKey);
  if (!entries) return;
  const idx = entries.findIndex((e) => e.client === client);
  if (idx < 0) return;
  const entry = entries[idx]!;
  entry.busy = false;
  if (entry.mcpSessionTokens) {
    cleanupExecutorSessions(entry.mcpSessionTokens);
    entry.mcpSessionTokens = undefined;
  }
  entries.splice(idx, 1);
  if (entries.length === 0) clientPool.delete(poolKey);
  try { await client.disconnect(); } catch { /* 정리 실패 무시 */ }
  client.removeAllListeners();
}

function replaceEntryClient(
  poolKey: string,
  entry: PooledClient,
  newClient: IUnifiedAgentClient,
  builtinExternalMcpSignature: string,
  internalExecutorMcpSignature: string,
): void {
  entry.client.removeAllListeners();
  entry.client = newClient;
  entry.builtinExternalMcpSignature = builtinExternalMcpSignature;
  entry.internalExecutorMcpSignature = internalExecutorMcpSignature;
  delete entry.sessionId;
  entry.mcpSessionTokens = undefined;
  newClient.on("exit", () => {
    removeEntryFromPool(poolKey, newClient);
  });
}

function isClientAlive(client: IUnifiedAgentClient): boolean {
  const info = client.getConnectionInfo();
  return info.state === "ready" || info.state === "connected";
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Aborted"));
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    }),
  ]);
}

async function buildConnectOptions(
  cli: CliType,
  cwd: string,
  overrides: { model?: string; promptIdleTimeout?: number; effort?: string } | undefined,
  systemPrompt: string | null | undefined,
  mcpServers?: McpServerConfig[],
): Promise<UnifiedClientOptions> {
  const opts: UnifiedClientOptions = {
    cwd,
    cli,
    autoApprove: true,
    clientInfo: CLIENT_INFO,
    timeout: 0,
  };
  if (overrides?.model) opts.model = overrides.model;
  if (overrides?.effort) opts.effort = overrides.effort;
  if (overrides?.promptIdleTimeout !== undefined) opts.promptIdleTimeout = overrides.promptIdleTimeout;
  if (systemPrompt) opts.systemPrompt = systemPrompt;
  if (mcpServers) opts.mcpServers = mcpServers;
  opts.strictMcp = true;
  const env = await resolveAuthEnv(cli);
  if (Object.keys(env).length > 0) opts.env = env;
  return opts;
}

function hasSystemPromptDrift(client: IUnifiedAgentClient, expected: string | null | undefined): boolean {
  return (client.getCurrentSystemPrompt()?.trim() ?? "") !== (expected?.trim() ?? "");
}

function debugSystemPromptDrift(scope: string, poolKey: string, cliType: CliType): void {
  console.warn(`[unified-agent] systemPrompt drift 감지 (${scope}, key=${poolKey}, cli=${cliType})`);
}

function attachStderrLogging(client: IUnifiedAgentClient, source: string): () => void {
  const onLogEntry = (entry: { message: string; cli?: string; sessionId?: string }) => {
    const normalized = normalizeDiagnosticStderr(entry.message);
    if (!normalized) return;
    const parts = [
      entry.cli ? `cli=${entry.cli}` : null,
      entry.sessionId ? `session=${entry.sessionId}` : null,
      normalized,
    ].filter(Boolean);
    getLogAPI().debug(source, parts.join(" "), { category: "acp-stderr", hideFromFooter: true });
  };
  client.on("logEntry", onLogEntry);
  return () => { client.off("logEntry", onLogEntry); };
}

function normalizeDiagnosticStderr(message: string): string | null {
  const stripped = message.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!stripped) return null;
  if (/^[\|\/\\\-⠁-⣿\.\s]+$/.test(stripped)) return null;
  return stripped;
}

function extractConnectedModel(connectResult: ConnectResult): string | undefined {
  const sessionAny = connectResult.session as Record<string, unknown> | undefined;
  if (sessionAny?.models && Array.isArray(sessionAny.models) && sessionAny.models.length > 0) {
    return String(sessionAny.models[0]);
  }
  return undefined;
}

function extractToolResultText(data?: ToolCallLike): string | undefined {
  if (!data) return undefined;
  const contentText = extractContentText(data.content);
  if (contentText) return contentText;
  if (data.rawOutput !== undefined && data.rawOutput !== null) {
    return typeof data.rawOutput === "string" ? data.rawOutput : JSON.stringify(data.rawOutput, null, 2);
  }
  return undefined;
}

function extractContentText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const typedItem = item as {
      type?: unknown;
      content?: { type?: unknown; text?: unknown };
      path?: unknown;
      newText?: unknown;
      oldText?: unknown;
    };
    if (typedItem.type === "content") {
      const block = typedItem.content;
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      continue;
    }
    if (typedItem.type === "diff" && typeof typedItem.path === "string" && typeof typedItem.newText === "string") {
      const newLines = typedItem.newText.split("\n").length;
      const oldLines = typeof typedItem.oldText === "string" ? typedItem.oldText.split("\n").length : 0;
      const delta = newLines - oldLines;
      parts.push(`${typedItem.path}: ${delta >= 0 ? `+${delta}` : `${delta}`} lines`);
    }
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

async function buildProviderClient(options: UnifiedAgentBuildOptions): Promise<IUnifiedAgentClient> {
  return UnifiedAgent.build(options);
}

/**
 * ACP `tool_call_update`의 title이 도구 종류 prefix 없이 파일 경로/인자만 도착하는 경우
 * (예: `"packages/.../npx.ts"`), `data.kind`를 활용해 사람이 읽기 쉬운 prefix를 합성한다.
 *
 * - title이 비어있으면 그대로 빈 문자열 반환 (머지 가드 동작 유지)
 * - title이 이미 kind 라벨로 시작하면 변형하지 않음 (예: "Read /tmp/x.txt")
 * - 파일 경로 패턴(슬래시 또는 점으로 시작)이면 `{Label} {title}` 형태로 prefix 추가
 * - 그 외(이미 의미있는 단어로 시작하는 일반 라벨)는 변형하지 않음
 */
function enrichToolTitle(title: string, kind?: string): string {
  if (!title) return "";
  if (!kind) return title;
  const label = toolKindLabel(kind);
  if (!label) return title;
  if (title.toLowerCase().startsWith(label.toLowerCase())) return title;
  // 파일 경로 패턴이면 prefix 합성
  if (title.startsWith("/") || title.startsWith(".") || title.includes("/")) {
    return `${label} ${title}`;
  }
  return title;
}

function toolKindLabel(kind: string): string {
  switch (kind) {
    case "read": return "Read";
    case "edit": return "Edit";
    case "delete": return "Delete";
    case "move": return "Move";
    case "search": return "Search";
    case "execute": return "Execute";
    case "think": return "Think";
    case "fetch": return "Fetch";
    case "switch_mode": return "Switch Mode";
    case "other": return "";
    default: return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
}

async function setupExecutorMcp(
  cwd: string,
  signal?: AbortSignal,
  carrierId?: string,
): Promise<ExecutorMcpSetup | null> {
  if (signal?.aborted) return null;
  const tokens: ExecutorMcpSessionToken[] = [];
  const mcpServers: McpServerConfig[] = [];

  for (const { name, runtime } of executorPortRuntime.getExecutorMcpRouterRuntimes()) {
    const specs = executorPortRuntime.getExecutorMcpTools(name, carrierId);
    if (specs.length === 0) continue;
    try {
      const mcpUrl = await runtime.server.start();
      const token = randomUUID();
      registerActiveExecutorSessionTools(runtime, token, [...specs]);
      tokens.push({ serverName: name, token });
      mcpServers.push({
        type: "http",
        url: mcpUrl,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
        name,
        toolTimeout: 1800,
      });
    } catch (err) {
      cleanupExecutorSessions(tokens);
      throw err;
    }
  }

  try {
    mcpServers.push(...resolveBuiltinExternalMcpServers(getAllowedBuiltinExternalMcpServerIds(carrierId)));
  } catch (err) {
    console.warn(
      `[unified-agent] builtin external MCP resolve 실패 (carrierId=${carrierId ?? "none"}, servers=${formatBuiltinExternalMcpServerIds(carrierId)}): ${err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  assertInternalMcpTokensNotShared(mcpServers, tokens);
  if (mcpServers.length === 0) {
    return null;
  }
  return { tokens, mcpServers };
}

function getAllowedBuiltinExternalMcpServerIds(carrierId?: string): readonly string[] {
  return executorPortRuntime.getCarrierExternalMcpServerIds(carrierId);
}

function formatBuiltinExternalMcpServerIds(carrierId?: string): string {
  const ids = getAllowedBuiltinExternalMcpServerIds(carrierId);
  return ids.length === 0 ? "none" : ids.join(",");
}

export function assertInternalMcpTokensNotShared(
  mcpServers: readonly McpServerConfig[],
  tokens: readonly ExecutorMcpSessionToken[],
): void {
  if (tokens.length === 0) return;
  const tokenValues = new Map<string, string>();
  for (const { serverName, token } of tokens) {
    if (tokenValues.has(token)) {
      throw new Error(
        `Internal MCP Bearer token reused by "${tokenValues.get(token)}" and "${serverName}".`,
      );
    }
    tokenValues.set(token, serverName);
  }

  for (const server of mcpServers) {
    if (INTERNAL_MCP_SERVER_NAMES.has(server.name)) continue;
    for (const { serverName, token } of tokens) {
      if (server.headers?.some((header) => header.value.includes(token))) {
        throw new Error(
          `Internal MCP Bearer token for "${serverName}" leaked into external MCP server "${server.name}".`,
        );
      }
    }
  }
}

function buildBuiltinExternalMcpSignature(carrierId?: string): string {
  const ids = [...getAllowedBuiltinExternalMcpServerIds(carrierId)].sort();
  return createHash("sha256").update(ids.join("\0")).digest("hex");
}

function buildInternalExecutorMcpSignature(carrierId?: string): string {
  const entries: string[] = [];

  for (const { name } of executorPortRuntime.getExecutorMcpRouterRuntimes()) {
    const specs = executorPortRuntime.getExecutorMcpTools(name, carrierId);
    if (specs.length === 0) continue;
    for (const spec of specs) {
      entries.push(`${name}\0${spec.id}\0${stableStringify(convertToolSchema(spec.parameters))}`);
    }
  }

  entries.sort();
  return createHash("sha256").update(entries.join("\0")).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
