import crypto from "node:crypto";
import {
  createInProcessMcpServer,
  createMcpToolRegistry,
  createMcpToolSnapshotStore,
  installExecutorToolCallRouter,
  registerExecutorSessionTools,
  cleanupExecutorSession,
  type InProcessMcpServer,
  type McpToolRegistry,
  type McpToolSnapshotStore,
} from "@dotobokuri/core-agent";
import {
  UnifiedAgent,
  type AcpPermissionRequestParams,
  type AcpPermissionResponse,
  type IUnifiedAgentClient,
} from "@dotobokuri/core-unified-agent";
import { ANALYST_SYSTEM_PROMPT } from "./prompt.js";
import { ANALYST_TOOL_IDS, AnalystTools } from "./tools.js";
import { redactTranscriptString } from "./transcript-indexer.js";
import type { AnalystSessionOptions } from "./types.js";

const DISPOSE_SETTLE_MS = 2_000;
const ANALYST_MCP_SERVER = "session_analyst";
const ANALYST_MCP_TOOLS = new Set<string>(Object.values(ANALYST_TOOL_IDS));

/** Owns every per-analysis resource. Nothing survives dispose(). */
export class AnalystSession {
  private readonly token = crypto.randomUUID();
  private readonly registry: McpToolRegistry = createMcpToolRegistry();
  private readonly snapshotStore: McpToolSnapshotStore = createMcpToolSnapshotStore();
  private readonly server: InProcessMcpServer = createInProcessMcpServer({ toolSnapshotStore: this.snapshotStore, serverInfo: { name: "session-analyst" } });
  private readonly options: AnalystSessionOptions;
  private readonly tools: AnalystTools;
  private client: IUnifiedAgentClient | null = null;
  private pendingClient: IUnifiedAgentClient | null = null;
  private started = false;
  private disposed = false;
  private turn: Promise<void> = Promise.resolve();
  private disposeFlight: Promise<void> | null = null;
  constructor(options: AnalystSessionOptions) {
    this.options = { ...options };
    this.tools = new AnalystTools(this.options);
  }
  async start(): Promise<void> {
    if (this.disposed) throw new Error("Session disposed");
    if (this.started) return;
    await this.tools.refresh();
    this.throwIfDisposed();
    const specs = this.tools.specs();
    for (const spec of specs) this.registry.registerExecutorTool(spec);
    registerExecutorSessionTools({ registry: this.registry, server: this.server, snapshotStore: this.snapshotStore }, this.token, specs);
    installExecutorToolCallRouter({ registry: this.registry, server: this.server, snapshotStore: this.snapshotStore }, this.token, { cwd: this.options.cwd });
    const url = await this.server.start();
    this.throwIfDisposed();
    const client = await UnifiedAgent.build({ cli: this.options.cliId });
    this.pendingClient = client;
    if (this.disposed) {
      await client.disconnect().catch(() => undefined);
      if (this.pendingClient === client) this.pendingClient = null;
      throw new Error("Session disposed");
    }
    this.bridge(client);
    try {
      await client.connect({ cwd: this.options.cwd, model: this.options.model, effort: this.options.effort, autoApprove: true, fsAccess: false, yoloMode: true, strictMcp: this.options.cliId === "claude" || this.options.cliId === "claude-kimi", systemPrompt: ANALYST_SYSTEM_PROMPT, mcpServers: [{ type: "http", name: ANALYST_MCP_SERVER, url, headers: [{ name: "Authorization", value: `Bearer ${this.token}` }] }] });
    } catch (error) {
      if (this.disposed) await (this.disposeFlight ?? Promise.resolve());
      else await client.disconnect().catch(() => undefined);
      if (this.pendingClient === client) this.pendingClient = null;
      throw error;
    }
    if (this.disposed) {
      await (this.disposeFlight ?? Promise.resolve());
      throw new Error("Session disposed");
    }
    this.pendingClient = null;
    this.client = client; this.started = true;
  }
  send(text: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Session disposed"));
    if (!this.started || !this.client) return Promise.reject(new Error("Session not started"));
    if (!text.trim()) return Promise.reject(new Error("Message required"));
    const run = this.turn.then(async () => { await this.client!.sendMessage(text); });
    this.turn = run.catch(() => undefined);
    return run;
  }
  dispose(): Promise<void> {
    if (this.disposeFlight) return this.disposeFlight;
    this.disposed = true;
    this.disposeFlight = this.disposeResources();
    return this.disposeFlight;
  }
  private async disposeResources(): Promise<void> {
    const client = this.client ?? this.pendingClient;
    const cancel = client?.cancelPrompt().catch(() => undefined) ?? Promise.resolve();
    await settleWithin([cancel, this.turn.catch(() => undefined)], DISPOSE_SETTLE_MS);
    cleanupExecutorSession({ registry: this.registry, server: this.server, snapshotStore: this.snapshotStore }, this.token);
    try { await client?.disconnect(); } finally {
      if (this.client === client) this.client = null;
      if (this.pendingClient === client) this.pendingClient = null;
      await this.server.stop();
      this.started = false;
    }
  }
  private bridge(client: IUnifiedAgentClient): void {
    client.on("messageChunk", text => this.options.onEvent?.({ type: "chunk", text: redactTranscriptString(text) }));
    client.on("thoughtChunk", text => this.options.onEvent?.({ type: "thought", text: redactTranscriptString(text) }));
    client.on("toolCall", (title, status) => this.options.onEvent?.({ type: "tool", title: redactTranscriptString(title), status }));
    client.on("toolCallUpdate", (title, status) => this.options.onEvent?.({ type: "tool", title: redactTranscriptString(title), status }));
    client.on("permissionRequest", (params, resolve) => resolvePermissionRequest(params, resolve));
    client.on("promptComplete", () => this.options.onEvent?.({ type: "complete" }));
    client.on("error", error => this.options.onEvent?.({ type: "error", error: { code: "analysis_error", message: redactTranscriptString(error.message) } }));
    client.on("exit", (code, signal) => this.options.onEvent?.({ type: "error", error: { code: "analysis_exited", message: `Analysis process exited (code ${code ?? "unknown"}, signal ${signal ?? "none"})` } }));
  }
  private throwIfDisposed(): void { if (this.disposed) throw new Error("Session disposed"); }
}

function resolvePermissionRequest(
  params: AcpPermissionRequestParams,
  resolve: (response: AcpPermissionResponse) => void,
): void {
  const allowed = belongsToAnalystMcp(params);
  const option = allowed
    ? params.options.find((candidate) => candidate.kind === "allow_once") ?? params.options.find((candidate) => candidate.kind === "allow_always")
    : params.options.find((candidate) => candidate.kind === "reject_once") ?? params.options.find((candidate) => candidate.kind === "reject_always");
  resolve(option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } });
}

function belongsToAnalystMcp(params: AcpPermissionRequestParams): boolean {
  const rawInput = record(params.toolCall.rawInput);
  if (hasExplicitMcpOwner(rawInput)) return true;
  return [params.toolCall.title, params.toolCall.toolCallId]
    .some((candidate) => typeof candidate === "string" && isQualifiedAnalystToolName(candidate));
}

function hasExplicitMcpOwner(value: Record<string, unknown>): boolean {
  const server = firstString(value, ["serverName", "server_name", "mcpServer", "mcp_server"]);
  const tool = firstString(value, ["toolName", "tool_name", "name"]);
  return server === ANALYST_MCP_SERVER && tool !== undefined && ANALYST_MCP_TOOLS.has(tool);
}

function isQualifiedAnalystToolName(value: string): boolean {
  const normalized = value.trim();
  const prefixes = [
    `mcp__${ANALYST_MCP_SERVER}__`,
    `${ANALYST_MCP_SERVER}__`,
    `${ANALYST_MCP_SERVER}.`,
    `${ANALYST_MCP_SERVER}/`,
    `${ANALYST_MCP_SERVER}:`,
  ];
  for (const prefix of prefixes) {
    if (!normalized.startsWith(prefix)) continue;
    return ANALYST_MCP_TOOLS.has(normalized.slice(prefix.length).trim());
  }
  return false;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string") return value[key];
  return undefined;
}

async function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
