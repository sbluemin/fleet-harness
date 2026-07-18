import { afterEach, describe, expect, it } from "vitest";

import {
  createExecutorSessionManager,
  createInProcessMcpServer,
  createMcpToolRegistry,
  createMcpToolSnapshotStore,
  registerExecutorSessionTools,
} from "../src/index.js";
import type {
  AgentToolSpec,
  InProcessMcpServer,
  JsonRpcResponse,
  McpRouterRuntime,
} from "../src/index.js";

const TOKEN = "session-token";

let activeServers: InProcessMcpServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.map((server) => server.stop()));
  activeServers = [];
});

describe("in-process MCP JSON-RPC server", () => {
  it("loopback HTTP endpoint에서 bearer 인증과 tools/list를 처리한다", async () => {
    const snapshotStore = createMcpToolSnapshotStore();
    const server = createInProcessMcpServer({
      serverInfo: { name: "test-tools", version: "0.0.0" },
      toolSnapshotStore: snapshotStore,
    });
    activeServers.push(server);
    snapshotStore.registerToolsForSession(TOKEN, [{
      name: "echo",
      description: "echo tool",
      parameters: { type: "object" },
    }]);

    const url = await server.start();
    const unauthorized = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const authorized = await postJsonRpc(url, TOKEN, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    expect(url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(unauthorized.status).toBe(401);
    expect(authorized.result).toEqual({
      tools: [{
        name: "echo",
        description: "echo tool",
        inputSchema: { type: "object" },
      }],
    });
  });

  it("tools/call은 세션별 FIFO pending call로 resolve된다", async () => {
    const snapshotStore = createMcpToolSnapshotStore();
    const server = createInProcessMcpServer({ toolSnapshotStore: snapshotStore });
    activeServers.push(server);
    snapshotStore.registerToolsForSession(TOKEN, [{
      name: "echo",
      description: "echo tool",
      parameters: { type: "object" },
    }]);
    server.setOnToolCallArrived(TOKEN, (toolName, args) => {
      expect(toolName).toBe("echo");
      expect(args).toEqual({ value: "hello" });
      queueMicrotask(() => {
        server.resolveNextToolCall(TOKEN, "call-1", {
          content: [{ type: "text", text: "ok" }],
          isError: false,
        });
      });
      return "call-1";
    });

    const response = await postJsonRpc(await server.start(), TOKEN, {
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "echo", arguments: { value: "hello" } },
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "call",
      result: {
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    });
    expect(server.hasPendingToolCall(TOKEN)).toBe(false);
  });
});

describe("executor session manager", () => {
  it("main session과 executor session을 token과 tool snapshot으로 분리한다", async () => {
    const registry = createMcpToolRegistry();
    const snapshotStore = createMcpToolSnapshotStore();
    const server = createInProcessMcpServer({ toolSnapshotStore: snapshotStore });
    activeServers.push(server);
    const runtime: McpRouterRuntime = { registry, server, snapshotStore };
    const allTool = makeToolSpec("all_tool");
    const executorOnly = makeToolSpec("executor_only");
    registry.registerAgentTool(allTool);
    registry.registerAgentTool(executorOnly);
    const manager = createExecutorSessionManager({
      runtimes: [{ name: "tools", runtime }],
    });

    const mainTokens = manager.issueSessionToken({
      label: "main",
      cwd: process.cwd(),
    });
    const executorSession = await manager.createExecutorMcpSession({
      serverName: "tools",
      specs: [executorOnly],
      cwd: process.cwd(),
    });

    expect(mainTokens).toHaveLength(1);
    expect(mainTokens[0]!.token).not.toBe(executorSession.token);
    expect(snapshotStore.getToolNamesForSession(mainTokens[0]!.token)).toEqual(
      new Set(["all_tool", "executor_only"]),
    );
    expect(snapshotStore.getToolNamesForSession(executorSession.token)).toEqual(
      new Set(["executor_only"]),
    );

    executorSession.cleanup();
    expect(snapshotStore.getToolsForSession(executorSession.token)).toHaveLength(0);
    manager.cleanup();
    expect(snapshotStore.getToolsForSession(mainTokens[0]!.token)).toHaveLength(0);
  });

  it("issued session labels reach agent tool execution through the MCP router", async () => {
    const registry = createMcpToolRegistry();
    const snapshotStore = createMcpToolSnapshotStore();
    const server = createInProcessMcpServer({ toolSnapshotStore: snapshotStore });
    activeServers.push(server);
    const runtime: McpRouterRuntime = { registry, server, snapshotStore };
    const seenSessionLabels: Array<string | undefined> = [];
    registry.registerAgentTool({
      ...makeToolSpec("session_label_probe"),
      async execute(_args, ctx) {
        seenSessionLabels.push(ctx.sessionLabel);
        return "ok";
      },
    });
    const manager = createExecutorSessionManager({
      runtimes: [{ name: "tools", runtime }],
    });

    const tokens = manager.issueSessionToken({
      label: "terminal-a",
      cwd: process.cwd(),
    });
    const response = await postJsonRpc(await server.start(), tokens[0]!.token, {
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "session_label_probe", arguments: {} },
    });

    expect(response.result).toEqual({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    expect(seenSessionLabels).toEqual(["terminal-a"]);
    manager.cleanup();
  });

  it("dedicated sessions freeze a caller binding snapshot independently of execution cwd", async () => {
    const registry = createMcpToolRegistry();
    const snapshotStore = createMcpToolSnapshotStore();
    const server = createInProcessMcpServer({ toolSnapshotStore: snapshotStore });
    activeServers.push(server);
    const runtime: McpRouterRuntime = { registry, server, snapshotStore };
    const seen: Array<{ cwd: string; bindings: Record<string, string> | undefined; frozen: boolean }> = [];
    registry.registerAgentTool({
      ...makeToolSpec("binding_snapshot_probe"),
      async execute(_args, ctx) {
        seen.push({ cwd: ctx.cwd, bindings: ctx.serverBindings, frozen: Object.isFrozen(ctx.serverBindings) });
        return "ok";
      },
    });
    const manager = createExecutorSessionManager({ runtimes: [{ name: "tools", runtime }] });
    const callerBindings: Record<string, string> = { workspace: "/server-workspace" };
    const tokens = manager.issueSessionToken({
      label: "bound-session",
      cwd: "/execution-worktree",
      serverBindings: callerBindings,
    });
    callerBindings.workspace = "/mutated-caller-value";

    await postJsonRpc(await server.start(), tokens[0]!.token, {
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "binding_snapshot_probe", arguments: {} },
    });

    expect(seen).toEqual([{
      cwd: "/execution-worktree",
      bindings: { workspace: "/server-workspace" },
      frozen: true,
    }]);
    manager.cleanup();
  });
});

function makeToolSpec(id: string): AgentToolSpec {
  return {
    id,
    tag: id,
    title: id,
    description: id,
    promptSnippet: id,
    whenToUse: [],
    whenNotToUse: [],
    usageGuidelines: [],
    parameters: {},
    async execute() {
      return "ok";
    },
  };
}

async function postJsonRpc(
  url: string,
  token: string,
  body: unknown,
): Promise<JsonRpcResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return await response.json() as JsonRpcResponse;
}
