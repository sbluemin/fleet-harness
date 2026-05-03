/**
 * admiral/agent/internal/executor-engine — 풀 기반 carrier executor 구현체.
 *
 * executeWithPool / executeOneShot의 내부 엔진.
 * globalThis 대신 모듈 레벨 Map 사용.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import {
  UnifiedAgent,
  type AcpToolCall,
  type AcpToolCallUpdate,
  type CliType,
  type ConnectResult,
  type IUnifiedAgentClient,
  type UnifiedAgentBuildOptions,
  type UnifiedClientOptions,
} from "@sbluemin/unified-agent";

import { resolveAuthEnv } from "../../../infra/auth/index.js";
import { getLogAPI } from "../../../infra/log/store.js";
import { getSessionStore, classifyResumeFailure } from "./session-runtime.js";
import { applyPostConnectConfig } from "./post-connect.js";
import type { TrackStatus } from "../../_shared/carrier-job-events.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export interface CarrierExecuteOptions {
  carrierId: string;
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

export interface CarrierExecResult {
  responseText: string;
  thoughtText: string;
  toolCalls: { title: string; status: string; rawOutput?: string; toolCallId?: string }[];
  status: TrackStatus;
  error?: string;
  sessionId?: string;
}

interface PooledClient {
  client: IUnifiedAgentClient;
  busy: boolean;
  sessionId?: string;
}

type ToolCallLike = (AcpToolCall | AcpToolCallUpdate) & {
  content?: unknown;
  rawOutput?: unknown;
  toolCallId?: string;
};

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const CLIENT_INFO = { name: "pi-unified-agent", version: "1.0.0" } as const;
const MAX_TOOL_CALLS_TO_KEEP = 30;

// ═══════════════════════════════════════════════════════════════════════════
// Module-level pool (globalThis 대체)
// ═══════════════════════════════════════════════════════════════════════════

const clientPool = new Map<string, PooledClient>();
const launchConfigs = new Map<string, { effort?: string }>();

// ═══════════════════════════════════════════════════════════════════════════
// Functions (공개 — executor.ts facade에서 호출)
// ═══════════════════════════════════════════════════════════════════════════

export async function engineExecuteWithPool(opts: CarrierExecuteOptions): Promise<CarrierExecResult> {
  const { carrierId, cliType, request, cwd, signal } = opts;
  const store = getSessionStore();

  let responseText = "";
  let thoughtText = "";
  const toolCalls: CarrierExecResult["toolCalls"] = [];
  let status: TrackStatus = "conn";
  let error: string | undefined;
  let aborted = false;
  let isLivePrompt = false;
  let sessionId: string | undefined;

  opts.onStatusChange?.("conn");

  let poolEntry = clientPool.get(carrierId);
  let isTemporary = false;

  if (poolEntry) {
    if (poolEntry.busy) {
      poolEntry = undefined;
      isTemporary = true;
    } else if (!isClientAlive(poolEntry.client)) {
      clientPool.delete(carrierId);
      poolEntry = undefined;
    }
  }

  let client: IUnifiedAgentClient;

  if (poolEntry) {
    client = poolEntry.client;
    poolEntry.busy = true;
  } else {
    client = await buildProviderClient({ cli: cliType });
    if (!isTemporary) {
      const newEntry: PooledClient = { client, busy: true };
      clientPool.set(carrierId, newEntry);
      poolEntry = newEntry;
      client.on("exit", () => {
        const current = clientPool.get(carrierId);
        if (current?.client === client) clientPool.delete(carrierId);
      });
    }
  }

  let detachStderr = attachStderrLogging(client, `acp-exec:${carrierId}`);

  const cleanupTemporary = async () => {
    if (!isTemporary) return;
    try { await client.disconnect(); } catch { /* 정리 실패 무시 */ }
    client.removeAllListeners();
  };

  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    status = "aborted";
    opts.onStatusChange?.("aborted");
    void Promise.allSettled([
      client.cancelPrompt(),
      isTemporary ? cleanupTemporary() : disconnectFromPool(carrierId, client),
    ]);
  };

  if (signal?.aborted) {
    detachStderr();
    if (poolEntry) poolEntry.busy = false;
    if (isTemporary) await cleanupTemporary();
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
    if (existing) {
      existing.status = tcStatus;
      if (rawOutput !== undefined) existing.rawOutput = rawOutput;
    } else {
      toolCalls.push({ title, status: tcStatus, rawOutput, toolCallId });
    }
    if (toolCalls.length > MAX_TOOL_CALLS_TO_KEEP) toolCalls.splice(0, toolCalls.length - MAX_TOOL_CALLS_TO_KEEP);
    opts.onToolCall?.(title, tcStatus, rawOutput, toolCallId);
  };
  const onToolCall = (title: string, tcStatus: string, _sid: string, data?: AcpToolCall) => {
    upsertToolCall(title, tcStatus, extractToolResultText(data as ToolCallLike | undefined), data?.toolCallId);
  };
  const onToolCallUpdate = (title: string, tcStatus: string, _sid: string, data?: AcpToolCallUpdate) => {
    upsertToolCall(title, tcStatus, extractToolResultText(data as ToolCallLike | undefined), data?.toolCallId);
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

    if (!needsConnect && hasSystemPromptDrift(client, opts.connectSystemPrompt ?? null)) {
      debugSystemPromptDrift("executeWithPool", carrierId, cliType);
      store.clear(carrierId);
      if (poolEntry) delete poolEntry.sessionId;
      await client.disconnect();
      needsConnect = true;
    }

    if (needsConnect) {
      const connectOpts = await buildConnectOptions(cliType, cwd, {
        model: opts.model,
        promptIdleTimeout: opts.promptIdleTimeout,
      }, opts.connectSystemPrompt ?? null);

      const savedSessionId = store.get(carrierId) ?? poolEntry?.sessionId;
      if (savedSessionId) connectOpts.sessionId = savedSessionId;

      let connectResult: ConnectResult;
      try {
        connectResult = await raceAbort(client.connect(connectOpts), signal);
      } catch (connectError) {
        if (aborted) throw connectError;
        if (!savedSessionId) throw connectError;
        if (classifyResumeFailure(connectError) !== "dead-session") throw connectError;

        console.error(
          `[unified-agent] session/load 실패 (carrierId=${carrierId}, sessionId=${savedSessionId}):`,
          connectError instanceof Error ? connectError.message : connectError,
        );

        store.clear(carrierId);
        if (poolEntry) delete poolEntry.sessionId;
        delete connectOpts.sessionId;

        try { await client.disconnect(); } catch {}
        detachListeners();
        detachStderr();
        client = await buildProviderClient({ cli: cliType });
        detachStderr = attachStderrLogging(client, `acp-exec:${carrierId}`);
        if (!isTemporary) {
          poolEntry = { client, busy: true };
          clientPool.set(carrierId, poolEntry);
          client.on("exit", () => {
            const current = clientPool.get(carrierId);
            if (current?.client === client) clientPool.delete(carrierId);
          });
        }
        attachListeners();
        connectResult = await raceAbort(client.connect(connectOpts), signal);
      }

      sessionId = connectResult.session?.sessionId ?? undefined;

      if (poolEntry && sessionId) poolEntry.sessionId = sessionId;
      if (sessionId) store.set(carrierId, sessionId);

      const effort = resolveEffort(carrierId, opts.effort);
      await applyPostConnectConfig(client, cliType, effort ? { effort } : undefined);
    } else {
      const info = client.getConnectionInfo();
      sessionId = info.sessionId ?? undefined;

      if (poolEntry && sessionId) poolEntry.sessionId = sessionId;
      if (sessionId) store.set(carrierId, sessionId);

      if (opts.effort) {
        await applyPostConnectConfig(client, cliType, { effort: opts.effort });
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

    await client.sendMessage(request);

    const postSendInfo = client.getConnectionInfo();
    if (postSendInfo.sessionId && postSendInfo.sessionId !== sessionId) {
      sessionId = postSendInfo.sessionId;
      if (poolEntry) poolEntry.sessionId = sessionId;
      store.set(carrierId, sessionId);
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

    if (isTemporary && sessionId) {
      const existingEntry = clientPool.get(carrierId);
      if (existingEntry) existingEntry.sessionId = sessionId;
    }
    await cleanupTemporary();
  }

  return { responseText, thoughtText, toolCalls, status, error, sessionId };
}

export async function engineExecuteOneShot(opts: CarrierExecuteOptions): Promise<CarrierExecResult> {
  const { cliType, request, cwd, signal } = opts;

  let responseText = "";
  let thoughtText = "";
  const toolCalls: CarrierExecResult["toolCalls"] = [];
  let status: TrackStatus = "conn";
  let error: string | undefined;
  let sessionId: string | undefined;

  opts.onStatusChange?.("conn");

  const client = await buildProviderClient({ cli: cliType });
  const detachStderr = attachStderrLogging(client, `acp-exec:${opts.carrierId}`);
  let aborted = false;

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

    const connectOpts = await buildConnectOptions(cliType, cwd, {
      model: opts.model,
      promptIdleTimeout: opts.promptIdleTimeout,
    }, opts.connectSystemPrompt ?? null);

    const connectResult = await raceAbort(client.connect(connectOpts), signal);
    await applyPostConnectConfig(client, cliType, { effort: opts.effort });

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
    try { await client.disconnect(); } catch { /* 정리 실패 무시 */ }
    client.removeAllListeners();
  }

  return { responseText, thoughtText, toolCalls, status, error, sessionId };
}

/** connections.ts에서 호출 — 특정 carrier 풀 엔트리 종료 */
export async function engineDisconnect(carrierId: string): Promise<boolean> {
  const entry = clientPool.get(carrierId);
  if (!entry) return false;
  clientPool.delete(carrierId);
  entry.busy = false;
  try { await entry.client.disconnect(); } catch { /* 강제 정리 경로 */ }
  entry.client.removeAllListeners();
  return true;
}

/** connections.ts에서 호출 — 전체 풀 정리 */
export async function engineDisconnectAll(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [, entry] of clientPool) {
    promises.push(entry.client.disconnect().catch(() => {}));
  }
  await Promise.allSettled(promises);
  clientPool.clear();
  launchConfigs.clear();
}

/** connections.ts에서 호출 — busy가 아닌 클라이언트 정리 */
export function engineCleanIdle(): void {
  for (const [key, entry] of clientPool) {
    if (!entry.busy) {
      entry.client.disconnect().catch(() => {});
      clientPool.delete(key);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════════

function resolveEffort(carrierId: string, override?: string): string | undefined {
  return override ?? launchConfigs.get(carrierId)?.effort;
}

async function disconnectFromPool(carrierId: string, client: IUnifiedAgentClient): Promise<boolean> {
  const entry = clientPool.get(carrierId);
  if (!entry || entry.client !== client) return false;
  clientPool.delete(carrierId);
  entry.busy = false;
  try { await entry.client.disconnect(); } catch { /* 정리 실패 무시 */ }
  entry.client.removeAllListeners();
  return true;
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
  overrides: { model?: string; promptIdleTimeout?: number } | undefined,
  systemPrompt: string | null | undefined,
): Promise<UnifiedClientOptions> {
  const opts: UnifiedClientOptions = {
    cwd,
    cli,
    autoApprove: true,
    clientInfo: CLIENT_INFO,
    timeout: 0,
  };
  if (overrides?.model) opts.model = overrides.model;
  if (overrides?.promptIdleTimeout !== undefined) opts.promptIdleTimeout = overrides.promptIdleTimeout;
  if (systemPrompt) opts.systemPrompt = systemPrompt;
  const env = await resolveAuthEnv(cli);
  if (Object.keys(env).length > 0) opts.env = env;
  return opts;
}

function hasSystemPromptDrift(client: IUnifiedAgentClient, expected: string | null | undefined): boolean {
  return (client.getCurrentSystemPrompt()?.trim() ?? "") !== (expected?.trim() ?? "");
}

function debugSystemPromptDrift(scope: string, key: string, cliType: CliType): void {
  console.warn(`[unified-agent] systemPrompt drift 감지 (${scope}, key=${key}, cli=${cliType})`);
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
