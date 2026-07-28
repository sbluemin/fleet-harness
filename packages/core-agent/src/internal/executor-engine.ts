/** Fresh, two-phase provider execution. */
import { randomUUID } from "node:crypto";
import {
  UnifiedAgent,
  getEffort,
  getProviderModels,
  type AcpToolCall,
  type AcpToolCallUpdate,
  type CliType,
  type IUnifiedAgentClient,
  type McpServerConfig,
  type ProtocolType,
  type UnifiedAgentBuildOptions,
  type UnifiedClientOptions,
} from "@dotobokuri/core-unified-agent";

import {
  cleanupExecutorSession as cleanupExecutorMcpSession,
  installExecutorToolCallRouter,
  registerExecutorSessionTools,
} from "../mcp-router.js";
import { executorMcpRuntimeProviderRuntime, executorPortRuntime, type ExecutorMcpSession } from "../executor-port.js";
import { resolveBuiltinExternalMcpServers } from "../external-mcp.js";
import { snapshotAgentServerBindings, type AgentServerBindings, type TrackStatus } from "../types.js";
import { applyPostConnectConfig } from "./post-connect.js";

export interface ExecuteOptions {
  readonly cliType: CliType;
  readonly authEnvResolver: AuthEnvResolver;
  readonly agentCliLaunchResolver?: AgentCliLaunchResolver;
  readonly request: string;
  readonly cwd: string;
  readonly serverBindings?: AgentServerBindings;
  readonly resumeSessionId?: string;
  readonly scopeId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly promptIdleTimeout?: number;
  readonly connectSystemPrompt?: string | null;
  readonly signal?: AbortSignal;
  readonly onMessageChunk?: (text: string) => void;
  readonly onThoughtChunk?: (text: string) => void;
  readonly onToolCall?: (title: string, status: string, rawOutput?: string, toolCallId?: string) => void;
  readonly onConnected?: (info: { sessionId: string; model?: string }) => void;
  readonly onStatusChange?: (status: TrackStatus) => void;
  readonly reservedExternalMcpServerIds?: readonly string[];
}

export type AuthEnvResolver = (cli: CliType, context?: { readonly model?: string; readonly effort?: string }) => Promise<Record<string, string>>;
export type AgentCliLaunchResolver = (
  cli: CliType,
  context: {
    readonly env: Readonly<Record<string, string>>;
    readonly model?: string;
    readonly effort?: string;
  },
) => Promise<{
  readonly cliPath?: string;
  readonly env?: Readonly<Record<string, string>>;
}>;

export type ExecResult = {
  responseText: string;
  thoughtText: string;
  toolCalls: { title: string; status: string; rawOutput?: string; toolCallId?: string }[];
  status: TrackStatus;
  error?: string;
  sessionId?: string;
};

export interface OneShotReady {
  readonly cliType: CliType;
  readonly protocol: ProtocolType;
  readonly sessionId: string;
}

export interface OneShotExecution {
  readonly readiness: Promise<OneShotReady>;
  readonly completion: Promise<ExecResult>;
  startPrompt(): void;
  abort(): Promise<void>;
}

type ToolCallLike = (AcpToolCall | AcpToolCallUpdate) & { content?: unknown; rawOutput?: unknown; toolCallId?: string };
interface ExecutorMcpSessionToken { readonly serverName: string; readonly token: string; readonly session?: ExecutorMcpSession; }
interface ExecutorMcpSetup { readonly tokens: readonly ExecutorMcpSessionToken[]; readonly mcpServers: McpServerConfig[]; }

const CLIENT_INFO = { name: "core-agent", version: "1.0.0" } as const;
const MAX_TOOL_CALLS_TO_KEEP = 30;

export function engineExecuteOneShot(opts: ExecuteOptions): OneShotExecution {
  assertAuthEnvResolver(opts.authEnvResolver);
  const serverBindings = snapshotAgentServerBindings(opts.serverBindings);
  let client: IUnifiedAgentClient | undefined;
  let activeMcpTokens: readonly ExecutorMcpSessionToken[] | undefined;
  let promptStarted = false;
  let aborted = false;
  let clientDisconnected = false;
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  let resolveReady!: (ready: OneShotReady) => void;
  let rejectReady!: (error: unknown) => void;
  const readiness = new Promise<OneShotReady>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  const disconnectClient = async () => {
    if (!client || clientDisconnected) return;
    clientDisconnected = true;
    try { await client.disconnect(); } catch { /* cleanup is best effort */ }
  };

  const abort = async () => {
    if (aborted) return;
    aborted = true;
    releasePrompt();
    await Promise.allSettled([client?.cancelPrompt() ?? Promise.resolve(), disconnectClient()]);
  };

  const completion = (async (): Promise<ExecResult> => {
    let responseText = "";
    let thoughtText = "";
    const toolCalls: ExecResult["toolCalls"] = [];
    let status: TrackStatus = "conn";
    let error: string | undefined;
    let sessionId: string | undefined;
    let readinessSettled = false;
    const cleanups: Array<() => void> = [];
    let rejectProviderFailure!: (error: Error) => void;
    const providerFailure = new Promise<never>((_, reject) => { rejectProviderFailure = reject; });
    const raceProviderFailure = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, providerFailure]);
    let onProviderError: ((cause: unknown) => void) | undefined;
    const finish = (nextStatus: TrackStatus, nextError?: string) => {
      status = nextStatus;
      error = nextError;
      opts.onStatusChange?.(nextStatus);
    };
    opts.onStatusChange?.("conn");
    try {
      if (opts.signal?.aborted) {
        aborted = true;
        finish("aborted");
        throw new Error("Aborted");
      }
      const onSignalAbort = () => { void abort(); };
      opts.signal?.addEventListener("abort", onSignalAbort, { once: true });
      cleanups.push(() => opts.signal?.removeEventListener("abort", onSignalAbort));

      client = await buildProviderClient({ cli: opts.cliType });
      onProviderError = (cause: unknown) => {
        const providerError = cause instanceof Error ? cause : new Error(String(cause));
        if (!readinessSettled) {
          rejectReady(providerError);
          readinessSettled = true;
        }
        rejectProviderFailure(providerError);
      };
      client.on("error", onProviderError);
      if (aborted) throw new Error("Aborted");
      const mcpSetup = await raceProviderFailure(setupExecutorMcp(
        opts.cwd,
        opts.signal,
        opts.scopeId,
        opts.reservedExternalMcpServerIds,
        serverBindings,
      ));
      activeMcpTokens = mcpSetup?.tokens;
      if (aborted) throw new Error("Aborted");
      const model = opts.model ?? getProviderModels(opts.cliType).defaultModel;
      const effort = resolveEffort(opts.cliType, model, opts.effort);
      const connectOpts = await raceProviderFailure(buildConnectOptions(opts.cliType, opts.cwd, {
        model: opts.model,
        promptIdleTimeout: opts.promptIdleTimeout,
        effort,
      }, opts.connectSystemPrompt, opts.authEnvResolver, opts.agentCliLaunchResolver, mcpSetup?.mcpServers));
      if (opts.resumeSessionId) connectOpts.sessionId = opts.resumeSessionId;
      const connectResult = await raceAbort(raceProviderFailure(client.connect(connectOpts)), opts.signal);
      await raceProviderFailure(applyResolvedEffort(client, opts.cliType, model, effort));
      if (activeMcpTokens) {
        installActiveExecutorToolCallRouter(activeMcpTokens, {
          cwd: opts.cwd,
          signal: opts.signal,
          serverBindings,
        });
      }
      sessionId = connectResult.session?.sessionId ?? client.getConnectionInfo().sessionId ?? undefined;
      const protocol = client.getConnectionInfo().protocol ?? connectResult.protocol;
      if (!sessionId || !protocol) throw new Error("Provider readiness did not expose a session identity and protocol.");
      if (aborted) throw new Error("Aborted");
      const ready = { cliType: opts.cliType, protocol, sessionId } as const;
      opts.onConnected?.({ sessionId, model });
      resolveReady(ready);
      readinessSettled = true;

      await raceProviderFailure(promptGate);
      if (aborted) {
        finish("aborted");
        return { responseText, thoughtText, toolCalls, status, error, sessionId };
      }
      promptStarted = true;
      finish("stream");
      const onMessageChunk = (text: string) => { responseText += text; opts.onMessageChunk?.(text); };
      const onThoughtChunk = (text: string) => { thoughtText += text; opts.onThoughtChunk?.(text); };
      const upsertToolCall = (title: string, toolStatus: string, rawOutput?: string, toolCallId?: string) => {
        const existing = toolCalls.find((item) => toolCallId ? item.toolCallId === toolCallId : item.title === title);
        const isFirstPush = !existing;
        if (existing) {
          if (title) existing.title = title;
          if (toolStatus) existing.status = toolStatus;
          if (rawOutput !== undefined) existing.rawOutput = rawOutput;
        } else {
          toolCalls.push({ title, status: toolStatus, rawOutput, toolCallId });
          if (toolCalls.length > MAX_TOOL_CALLS_TO_KEEP) toolCalls.splice(0, toolCalls.length - MAX_TOOL_CALLS_TO_KEEP);
        }
        const effective = existing ?? toolCalls[toolCalls.length - 1];
        if (isFirstPush && toolStatus === "pending") return;
        opts.onToolCall?.(title || effective?.title || "", toolStatus || effective?.status || "", rawOutput, toolCallId);
      };
      const onToolCall = (title: string, toolStatus: string, _id: string, data?: AcpToolCall) => upsertToolCall(enrichToolTitle(title, data?.kind), toolStatus, extractToolResultText(data as ToolCallLike | undefined), data?.toolCallId);
      const onToolCallUpdate = (title: string, toolStatus: string, _id: string, data?: AcpToolCallUpdate) => upsertToolCall(enrichToolTitle(title, data?.kind ?? undefined), toolStatus, extractToolResultText(data as ToolCallLike | undefined), data?.toolCallId);
      client.on("messageChunk", onMessageChunk).on("thoughtChunk", onThoughtChunk).on("toolCall", onToolCall).on("toolCallUpdate", onToolCallUpdate);
      cleanups.push(() => client?.off("messageChunk", onMessageChunk).off("thoughtChunk", onThoughtChunk).off("toolCall", onToolCall).off("toolCallUpdate", onToolCallUpdate));
      await raceProviderFailure(client.sendMessage(opts.request));
      sessionId = client.getConnectionInfo().sessionId ?? sessionId;
      if (aborted) finish("aborted");
      else {
        if (!responseText.trim()) responseText = "(no output)";
        finish("done");
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!readinessSettled) {
        rejectReady(cause);
        readinessSettled = true;
      }
      if (aborted || message === "Aborted") finish("aborted");
      else {
        finish("err", message);
        if (!responseText) responseText = `Error: ${message}`;
      }
    } finally {
      if (!readinessSettled) rejectReady(new Error("One-shot execution finalized before readiness."));
      for (const cleanup of cleanups.reverse()) cleanup();
      if (activeMcpTokens) cleanupExecutorSessions(activeMcpTokens);
      activeMcpTokens = undefined;
      if (client) {
        await disconnectClient();
        if (onProviderError) client.off("error", onProviderError);
        client.removeAllListeners();
      }
    }
    return { responseText, thoughtText, toolCalls, status, error, sessionId };
  })();

  return {
    readiness,
    completion,
    startPrompt() { if (!aborted && !promptStarted) releasePrompt(); },
    abort: async () => { await abort(); await completion; },
  };
}

function resolveEffort(cliType: CliType, model: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const configured = getEffort(cliType, model);
  return configured.supported ? configured.default : undefined;
}

async function applyResolvedEffort(client: IUnifiedAgentClient, cliType: CliType, model: string, effort?: string): Promise<void> {
  if (effort) await applyPostConnectConfig(client, cliType, model, { effort });
}

export function assertInternalMcpTokensNotShared(
  mcpServers: readonly McpServerConfig[],
  tokens: readonly ExecutorMcpSessionToken[],
  reservedIds: readonly string[] = [],
): void {
  if (!tokens.length) return;
  const internalNames = new Set([...tokens.map((token) => token.serverName), ...reservedIds]);
  const tokenOwners = new Map<string, string>();
  for (const { serverName, token } of tokens) {
    const owner = tokenOwners.get(token);
    if (owner) throw new Error(`Internal MCP Bearer token reused by "${owner}" and "${serverName}".`);
    tokenOwners.set(token, serverName);
  }
  for (const server of mcpServers) {
    if (internalNames.has(server.name)) continue;
    for (const { serverName, token } of tokens) {
      if (server.headers?.some((header) => header.value.includes(token))) {
        throw new Error(`Internal MCP Bearer token for "${serverName}" leaked into external MCP server "${server.name}".`);
      }
    }
  }
}

function cleanupExecutorSessions(tokens: readonly ExecutorMcpSessionToken[]): void {
  for (const { serverName, token, session } of tokens) {
    if (session) session.cleanup();
    else {
      const runtime = executorMcpRuntimeProviderRuntime.getExecutorMcpRouterRuntimes().find((entry) => entry.name === serverName)?.runtime;
      if (runtime) cleanupExecutorMcpSession(runtime, token);
    }
  }
}

function installActiveExecutorToolCallRouter(
  tokens: readonly ExecutorMcpSessionToken[],
  ctx: { cwd: string; signal?: AbortSignal; serverBindings?: AgentServerBindings },
): void {
  for (const { serverName, token } of tokens) {
    const runtime = executorMcpRuntimeProviderRuntime.getExecutorMcpRouterRuntimes().find((entry) => entry.name === serverName)?.runtime;
    if (runtime) installExecutorToolCallRouter(runtime, token, ctx);
  }
}

async function setupExecutorMcp(
  cwd: string,
  signal?: AbortSignal,
  scopeId?: string,
  reservedIds: readonly string[] = [],
  serverBindings?: AgentServerBindings,
): Promise<ExecutorMcpSetup | null> {
  if (signal?.aborted) return null;
  const tokens: ExecutorMcpSessionToken[] = [];
  const mcpServers: McpServerConfig[] = [];
  const provider = executorMcpRuntimeProviderRuntime.getProvider();
  try {
    for (const { name, runtime } of provider.getExecutorMcpRouterRuntimes()) {
      const specs = executorPortRuntime.getExecutorMcpTools(name, scopeId);
      if (!specs.length) continue;
      if (provider.createExecutorMcpSession) {
        const session = await provider.createExecutorMcpSession({
          serverName: name,
          specs,
          cwd,
          signal,
          serverBindings,
        });
        tokens.push({ serverName: name, token: session.token, session });
        mcpServers.push(session.mcpServer);
      } else {
        const token = randomUUID();
        registerExecutorSessionTools(runtime, token, [...specs]);
        tokens.push({ serverName: name, token });
        mcpServers.push({ type: "http", url: await runtime.server.start(), headers: [{ name: "Authorization", value: `Bearer ${token}` }], name, toolTimeout: 1800 });
      }
    }
    try {
      mcpServers.push(...resolveBuiltinExternalMcpServers(executorPortRuntime.getScopeExternalMcpServerIds(scopeId), { reservedIds }));
    } catch (error) {
      console.warn(
        `[unified-agent] builtin external MCP resolve 실패 (scopeId=${scopeId ?? "none"}, servers=${formatBuiltinExternalMcpServerIds(scopeId)}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    assertInternalMcpTokensNotShared(mcpServers, tokens, reservedIds);
    return mcpServers.length ? { tokens, mcpServers } : null;
  } catch (error) {
    cleanupExecutorSessions(tokens);
    throw error;
  }
}

async function buildConnectOptions(cli: CliType, cwd: string, overrides: { model?: string; promptIdleTimeout?: number; effort?: string }, systemPrompt: string | null | undefined, authEnvResolver: AuthEnvResolver, agentCliLaunchResolver?: AgentCliLaunchResolver, mcpServers?: McpServerConfig[]): Promise<UnifiedClientOptions> {
  const options: UnifiedClientOptions = { cwd, cli, autoApprove: true, clientInfo: CLIENT_INFO, timeout: 0, strictMcp: true, archiveSessionOnDisconnect: true };
  if (overrides.model) options.model = overrides.model;
  if (overrides.effort) options.effort = overrides.effort;
  if (overrides.promptIdleTimeout !== undefined) options.promptIdleTimeout = overrides.promptIdleTimeout;
  if (systemPrompt) options.systemPrompt = systemPrompt;
  if (mcpServers) options.mcpServers = mcpServers;
  const env = await authEnvResolver(cli, {
    ...(overrides.model ? { model: overrides.model } : {}),
    ...(overrides.effort ? { effort: overrides.effort } : {}),
  });
  const launch = await agentCliLaunchResolver?.(cli, {
    env,
    ...(overrides.model ? { model: overrides.model } : {}),
    ...(overrides.effort ? { effort: overrides.effort } : {}),
  });
  if (launch?.cliPath) options.cliPath = launch.cliPath;
  const mergedEnv = launch?.env ? { ...env, ...launch.env } : env;
  if (Object.keys(mergedEnv).length) options.env = mergedEnv;
  return options;
}

function assertAuthEnvResolver(value: AuthEnvResolver | undefined): asserts value is AuthEnvResolver {
  if (!value) throw new Error("core-agent execution requires authEnvResolver before connecting to a provider client.");
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Aborted"));
  return Promise.race([promise, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }))]);
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
  return parts.length ? parts.join("\n") : undefined;
}

function enrichToolTitle(title: string, kind?: string): string {
  if (!title || !kind) return title;
  const label = toolKindLabel(kind);
  if (!label || title.toLowerCase().startsWith(label.toLowerCase())) return title;
  return title.startsWith("/") || title.startsWith(".") || title.includes("/") ? `${label} ${title}` : title;
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

function formatBuiltinExternalMcpServerIds(scopeId?: string): string {
  const ids = executorPortRuntime.getScopeExternalMcpServerIds(scopeId);
  return ids.length === 0 ? "none" : ids.join(",");
}

async function buildProviderClient(options: UnifiedAgentBuildOptions): Promise<IUnifiedAgentClient> { return UnifiedAgent.build(options); }
