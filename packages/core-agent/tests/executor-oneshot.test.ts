import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpContentBlock, AcpPromptResponse, ConnectResult, IUnifiedAgentClient, UnifiedClientOptions } from "@dotobokuri/core-unified-agent";

const buildMock = vi.fn();
vi.mock("@dotobokuri/core-unified-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dotobokuri/core-unified-agent")>();
  return { ...actual, UnifiedAgent: { ...actual.UnifiedAgent, build: buildMock }, getEffort: () => ({ supported: false }), getProviderModels: () => ({ defaultModel: "fake-model" }) };
});
const { executeOneShot } = await import("../src/index.js");
const {
  createMcpToolRegistry,
  createMcpToolSnapshotStore,
  executorMcpRuntimeProviderRuntime,
  executorPortRuntime,
} = await import("../src/index.js");

class FakeClient extends EventEmitter implements IUnifiedAgentClient {
  readonly connectCalls: UnifiedClientOptions[] = [];
  readonly messages: string[] = [];
  disconnectCount = 0; cancelCount = 0; sessionId?: string; protocol: "acp" | "codex-app-server" = "codex-app-server"; connectError?: Error; state: "disconnected" | "ready" = "disconnected"; onConnect?: () => void; onSend?: () => void;
  async connect(options: UnifiedClientOptions): Promise<ConnectResult> { this.connectCalls.push(options); this.onConnect?.(); if (this.connectError) throw this.connectError; this.state = "ready"; this.sessionId = options.sessionId ?? `session-${clients.indexOf(this) + 1}`; return { cli: "codex", protocol: this.protocol, session: { sessionId: this.sessionId } } as ConnectResult; }
  async disconnect(): Promise<void> { this.disconnectCount++; this.state = "disconnected"; }
  async endSession(): Promise<void> {} async detectClis(): Promise<[]> { return []; }
  async sendMessage(message: string | AcpContentBlock[]): Promise<AcpPromptResponse> { this.messages.push(typeof message === "string" ? message : JSON.stringify(message)); this.onSend?.(); return {} as AcpPromptResponse; }
  async cancelPrompt(): Promise<void> { this.cancelCount++; }
  getConnectionInfo(): ReturnType<IUnifiedAgentClient["getConnectionInfo"]> { return { state: this.state, sessionId: this.sessionId ?? null, cli: "codex", protocol: this.protocol }; }
  getCurrentSystemPrompt(): null { return null; } async setModel(): Promise<void> {} async setConfigOption(): Promise<void> {} async setMode(): Promise<void> {} async setYoloMode(): Promise<void> {} getAvailableModes(): [] { return []; } getAvailableModels(): null { return null; } async loadSession(): Promise<void> {} async resetSession(): Promise<ConnectResult> { return { cli: "codex", protocol: this.protocol, session: { sessionId: this.sessionId } } as ConnectResult; }
}
const clients: FakeClient[] = [];
const options = (request: string, extra: Partial<Parameters<typeof executeOneShot>[0]> = {}) => ({ cliType: "codex" as const, authEnvResolver: async () => ({}), request, cwd: "/workspace", ...extra });

describe("executeOneShot", () => {
  beforeEach(() => {
    clients.length = 0; buildMock.mockReset();
    buildMock.mockImplementation(async () => { const client = new FakeClient(); client.protocol = clients.length === 0 ? "codex-app-server" : "acp"; clients.push(client); return client; });
    executorPortRuntime.register({ getScopeExternalMcpServerIds: () => [], getExecutorMcpTools: () => [] });
    executorMcpRuntimeProviderRuntime.register({ getExecutorMcpRouterRuntimes: () => [] });
  });
  it("opens the prompt only after readiness and disconnects every fresh client", async () => {
    const first = executeOneShot(options("first"));
    await expect(first.readiness).resolves.toMatchObject({ cliType: "codex", protocol: "codex-app-server", sessionId: "session-1" });
    expect(clients[0]!.messages).toEqual([]);
    first.startPrompt(); await expect(first.completion).resolves.toMatchObject({ status: "done", sessionId: "session-1" });
    const second = executeOneShot(options("second")); await expect(second.readiness).resolves.toMatchObject({ protocol: "acp", sessionId: "session-2" }); second.startPrompt(); await second.completion;
    expect(buildMock).toHaveBeenCalledTimes(2); expect(clients.map((client) => client.disconnectCount)).toEqual([1, 1]);
  });
  it("passes an explicit resume ID once and never falls back to a fresh connection", async () => {
    buildMock.mockImplementationOnce(async () => { const client = new FakeClient(); client.connectError = new Error("session/load failed"); clients.push(client); return client; });
    const execution = executeOneShot(options("resume", { resumeSessionId: "provider-session" }));
    await expect(execution.readiness).rejects.toThrow("session/load failed"); await expect(execution.completion).resolves.toMatchObject({ status: "err" });
    expect(buildMock).toHaveBeenCalledTimes(1); expect(clients[0]!.connectCalls).toEqual([expect.objectContaining({ sessionId: "provider-session" })]); expect(clients[0]!.messages).toEqual([]); expect(clients[0]!.disconnectCount).toBe(1);
  });
  it("passes resolved Carrier cliPath and merges launch env after auth env", async () => {
    const agentCliLaunchResolver = vi.fn(async () => ({
      cliPath: "/custom/bin/codex",
      env: { CODEX_BIN: "/custom/bin/codex" },
    }));
    const execution = executeOneShot(options("custom path", {
      authEnvResolver: async () => ({ AUTH_TOKEN: "secret" }),
      agentCliLaunchResolver,
    }));

    await execution.readiness;
    expect(agentCliLaunchResolver).toHaveBeenCalledWith("codex", {
      env: { AUTH_TOKEN: "secret" },
    });
    expect(clients[0]!.connectCalls[0]).toMatchObject({
      cliPath: "/custom/bin/codex",
      env: {
        AUTH_TOKEN: "secret",
        CODEX_BIN: "/custom/bin/codex",
      },
    });
    await execution.abort();
  });
  it("rejects readiness without an unhandled EventEmitter error when the provider fails during connect", async () => {
    let errorListenerCount = 0;
    buildMock.mockImplementationOnce(async () => {
      const client = new FakeClient();
      client.onConnect = () => {
        errorListenerCount = client.listenerCount("error");
        client.emit("error", new Error("provider child spawn failed"));
      };
      clients.push(client);
      return client;
    });

    const execution = executeOneShot(options("fail before prompt"));

    await expect(execution.readiness).rejects.toThrow("provider child spawn failed");
    await expect(execution.completion).resolves.toMatchObject({ status: "err", error: "provider child spawn failed" });
    expect(errorListenerCount).toBe(1);
    expect(clients[0]!.disconnectCount).toBe(1);
    expect(clients[0]!.listenerCount("error")).toBe(0);
  });
  it("abort before prompt cleans the prepared one-shot without sending", async () => {
    const execution = executeOneShot(options("never-send")); await execution.readiness; await execution.abort();
    await expect(execution.completion).resolves.toMatchObject({ status: "aborted" }); expect(clients[0]!.messages).toEqual([]); expect(clients[0]!.cancelCount).toBeGreaterThan(0); expect(clients[0]!.disconnectCount).toBe(1);
  });
  it("keeps structured tool text, diff summaries, title enrichment, and pending merge semantics", async () => {
    const toolUpdates: Array<[string, string, string | undefined, string | undefined]> = [];
    const execution = executeOneShot(options("tool", { onToolCall: (title, status, output, id) => toolUpdates.push([title, status, output, id]) }));
    await execution.readiness;
    clients[0]!.onSend = () => {
      const data = {
        kind: "read",
        toolCallId: "tool-1",
        rawOutput: "raw fallback",
        content: [
          { type: "content", content: { type: "text", text: "structured result" } },
          { type: "diff", path: "src/file.ts", oldText: "old", newText: "new\nline" },
        ],
      };
      clients[0]!.emit("toolCall", "./src/file.ts", "pending", "", data);
      clients[0]!.emit("toolCallUpdate", "", "done", "", data);
    };
    execution.startPrompt();
    const result = await execution.completion;
    expect(toolUpdates).toEqual([["Read ./src/file.ts", "done", "structured result\nsrc/file.ts: +1 lines", "tool-1"]]);
    expect(result.toolCalls).toEqual([{ title: "Read ./src/file.ts", status: "done", rawOutput: "structured result\nsrc/file.ts: +1 lines", toolCallId: "tool-1" }]);
  });
  it("warns and continues when builtin external MCP resolution fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    executorPortRuntime.register({ getScopeExternalMcpServerIds: () => ["missing_server"], getExecutorMcpTools: () => [] });
    try {
      const execution = executeOneShot(options("continue", { scopeId: "scope-a" }));
      await expect(execution.readiness).resolves.toMatchObject({ sessionId: "session-1" });
      execution.startPrompt();
      await expect(execution.completion).resolves.toMatchObject({ status: "done" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("scopeId=scope-a, servers=missing_server"));
    } finally {
      warn.mockRestore();
    }
  });
  it("snapshots server bindings for one-shot MCP tools without adding them to provider options", async () => {
    const registry = createMcpToolRegistry();
    const snapshotStore = createMcpToolSnapshotStore();
    let handler: ((name: string, args: Record<string, unknown>) => string) | null = null;
    const resolveNextToolCall = vi.fn();
    const seen: Array<{ cwd: string; workspace: string | undefined; frozen: boolean }> = [];
    registry.registerExecutorTool({
      id: "oneshot_binding_probe",
      tag: "oneshot_binding_probe",
      title: "probe",
      description: "probe",
      promptSnippet: "probe",
      whenToUse: [],
      whenNotToUse: [],
      usageGuidelines: [],
      parameters: {},
      async execute(_args, ctx) {
        seen.push({
          cwd: ctx.cwd,
          workspace: ctx.serverBindings?.workspace,
          frozen: Object.isFrozen(ctx.serverBindings),
        });
        return "ok";
      },
    });
    const runtime = {
      registry,
      snapshotStore,
      server: {
        start: async () => "http://127.0.0.1:1/mcp",
        setOnToolCallArrived: (_token: string, callback: typeof handler) => { handler = callback; },
        resolveNextToolCall,
        clearPendingForSession: vi.fn(),
      },
    };
    executorPortRuntime.register({
      getScopeExternalMcpServerIds: () => [],
      getExecutorMcpTools: () => [registry.getExecutorMcpToolsForScope()[0]!],
    });
    executorMcpRuntimeProviderRuntime.register({ getExecutorMcpRouterRuntimes: () => [{ name: "tools", runtime }] });
    const callerBindings: Record<string, string> = { workspace: "/server-workspace" };
    const execution = executeOneShot(options("bound", {
      cwd: "/execution-worktree",
      serverBindings: callerBindings,
    }));
    callerBindings.workspace = "/mutated-caller-value";

    await execution.readiness;
    handler!("oneshot_binding_probe", {});
    await vi.waitFor(() => expect(resolveNextToolCall).toHaveBeenCalledTimes(1));
    expect(seen).toEqual([{ cwd: "/execution-worktree", workspace: "/server-workspace", frozen: true }]);
    expect(clients[0]!.connectCalls[0]).not.toHaveProperty("serverBindings");
    expect(clients[0]!.connectCalls[0]!.env).toBeUndefined();
    await execution.abort();
  });
});
