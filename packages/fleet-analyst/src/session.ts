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
import { UnifiedAgent, type IUnifiedAgentClient } from "@dotobokuri/core-unified-agent";
import { ANALYST_SYSTEM_PROMPT } from "./prompt.js";
import { AnalystTools } from "./tools.js";
import type { AnalystSessionOptions } from "./types.js";

/** Owns every per-analysis resource. Nothing survives dispose(). */
export class AnalystSession {
  private readonly token = crypto.randomUUID();
  private readonly registry: McpToolRegistry = createMcpToolRegistry();
  private readonly snapshotStore: McpToolSnapshotStore = createMcpToolSnapshotStore();
  private readonly server: InProcessMcpServer = createInProcessMcpServer({ toolSnapshotStore: this.snapshotStore, serverInfo: { name: "session-analyst" } });
  private readonly tools: AnalystTools;
  private client: IUnifiedAgentClient | null = null;
  private started = false;
  private disposed = false;
  private turn: Promise<void> = Promise.resolve();
  constructor(private readonly options: AnalystSessionOptions) { this.tools = new AnalystTools(options); }
  async start(): Promise<void> {
    if (this.disposed) throw new Error("Session disposed");
    if (this.started) return;
    await this.tools.refresh();
    const specs = this.tools.specs();
    for (const spec of specs) this.registry.registerExecutorTool(spec);
    registerExecutorSessionTools({ registry: this.registry, server: this.server, snapshotStore: this.snapshotStore }, this.token, specs);
    installExecutorToolCallRouter({ registry: this.registry, server: this.server, snapshotStore: this.snapshotStore }, this.token, { cwd: this.options.cwd });
    const url = await this.server.start();
    const client = await UnifiedAgent.build({ cli: this.options.cliId });
    this.bridge(client);
    await client.connect({ cwd: this.options.cwd, model: this.options.model, effort: this.options.effort, autoApprove: true, yoloMode: true, systemPrompt: ANALYST_SYSTEM_PROMPT, mcpServers: [{ type: "http", name: "session_analyst", url, headers: [{ name: "Authorization", value: `Bearer ${this.token}` }] }] });
    this.client = client; this.started = true;
  }
  send(text: string): Promise<void> {
    if (!this.started || !this.client) return Promise.reject(new Error("Session not started"));
    if (!text.trim()) return Promise.reject(new Error("Message required"));
    const run = this.turn.then(async () => { await this.client!.sendMessage(text); });
    this.turn = run.catch(() => undefined);
    return run;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.turn.catch(() => undefined);
    cleanupExecutorSession({ registry: this.registry, server: this.server, snapshotStore: this.snapshotStore }, this.token);
    try { await this.client?.disconnect(); } finally { this.client = null; await this.server.stop(); this.started = false; }
  }
  private bridge(client: IUnifiedAgentClient): void {
    client.on("messageChunk", text => this.options.onEvent?.({ type: "chunk", text }));
    client.on("thoughtChunk", text => this.options.onEvent?.({ type: "thought", text }));
    client.on("toolCall", (title, status) => this.options.onEvent?.({ type: "tool", title, status }));
    client.on("toolCallUpdate", (title, status) => this.options.onEvent?.({ type: "tool", title, status }));
    client.on("promptComplete", () => this.options.onEvent?.({ type: "complete" }));
    client.on("error", error => this.options.onEvent?.({ type: "error", error: { code: "analysis_error", message: error.message } }));
  }
}
