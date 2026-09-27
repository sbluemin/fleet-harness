import { afterEach, describe, expect, it } from "vitest";

import {
  createExecutorSessionManager,
  createServedMcpEndpoint,
  createMcpToolRegistry,
  createMcpToolSnapshotStore,
  registerExecutorSessionTools,
} from "../src/index.js";
import type {
  AgentToolSpec,
  ServedMcpEndpoint,
  JsonRpcResponse,
  McpRouterRuntime,
} from "../src/index.js";

const TOKEN = "session-token";

let activeServers: ServedMcpEndpoint[] = [];

afterEach(async () => {
  await Promise.all(activeServers.map((server) => server.stop()));
  activeServers = [];
});

describe("in-process MCP JSON-RPC server", () => {
  it("loopback HTTP endpoint에서 bearer 인증과 tools/list를 처리한다", async () => {
    const snapshotStore = createMcpToolSnapshotStore();
    const server = createServedMcpEndpoint({
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

  it("같은 세션의 병렬 tools/call 결과를 각 요청에 돌려주고 늦은 결과를 버린다", async () => {
    const registry = createMcpToolRegistry();
    const snapshotStore = createMcpToolSnapshotStore();
    const server = createServedMcpEndpoint({ toolSnapshotStore: snapshotStore });
    activeServers.push(server);
    const runtime: McpRouterRuntime = { registry, server, snapshotStore };
    const invocations = new Map<string, { toolCallId: string; resolve(value: string): void }>();
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    registry.registerAgentTool({
      ...makeToolSpec("echo"),
      execute(args, ctx) {
        const value = (args as { value: string }).value;
        return new Promise<string>((resolve) => {
          invocations.set(value, { toolCallId: ctx.toolCallId!, resolve });
          if (value === "first") markFirstStarted();
          else markSecondStarted();
        });
      },
    });
    const manager = createExecutorSessionManager({ runtimes: [{ name: "tools", runtime }] });
    const token = manager.issueSessionToken({ label: "parallel", cwd: process.cwd() })[0]!.token;
    const url = await server.start();
    const call = (id: string) => postJsonRpc(url, token, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "echo", arguments: { value: id } },
    });

    const firstResponse = call("first");
    await firstStarted;
    const secondResponse = call("second");
    await secondStarted;
    expect(() => server.resolveToolCall(token, "unknown", {
      content: [{ type: "text", text: "stale" }], isError: false,
    })).not.toThrow();
    invocations.get("second")!.resolve("second result");
    expect(await secondResponse).toEqual({
      jsonrpc: "2.0", id: "second",
      result: { content: [{ type: "text", text: "second result" }], isError: false },
    });
    invocations.get("first")!.resolve("first result");
    expect(await firstResponse).toEqual({
      jsonrpc: "2.0", id: "first",
      result: { content: [{ type: "text", text: "first result" }], isError: false },
    });
    server.resolveToolCall(token, invocations.get("first")!.toolCallId, {
      content: [{ type: "text", text: "late" }], isError: false,
    });

    server.setOnToolCallArrived(token, () => {
      server.resolveToolCall(token, "unknown", {
        content: [{ type: "text", text: "wrong" }], isError: false,
      });
      server.resolveToolCall(token, "synchronous", {
        content: [{ type: "text", text: "sync result" }], isError: false,
      });
      return "synchronous";
    });
    expect(await call("third")).toEqual({
      jsonrpc: "2.0", id: "third",
      result: { content: [{ type: "text", text: "sync result" }], isError: false },
    });
    expect(server.hasPendingToolCall(token)).toBe(false);
    manager.cleanup();
  });

  it("결과를 전달하지 못한 tools/call을 재실행 없이 전달 실패 오류로 즉시 끝낸다", async () => {
    const registry = createMcpToolRegistry();
    const snapshotStore = createMcpToolSnapshotStore();
    const server = createServedMcpEndpoint({ toolSnapshotStore: snapshotStore });
    activeServers.push(server);
    const failures: string[] = [];
    const runtime: McpRouterRuntime = {
      registry, server, snapshotStore,
      onFailure: (kind) => { failures.push(kind); },
    };
    let executions = 0;
    registry.registerAgentTool({
      ...makeToolSpec("effect"),
      async execute() {
        executions += 1;
        const error = new Error("unused");
        Object.defineProperty(error, "message", { get() { throw new Error("unreadable error"); } });
        throw error;
      },
    });
    const manager = createExecutorSessionManager({ runtimes: [{ name: "tools", runtime }] });
    const token = manager.issueSessionToken({ label: "delivery", cwd: process.cwd() })[0]!.token;
    const url = await server.start();
    const expectDeliveryFailure = (response: JsonRpcResponse, id: string) => {
      expect(response.id).toBe(id);
      const result = response.result as { content: Array<{ text: string }>; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/delivery failed.*may already have run/);
    };

    // The error result cannot be built, so the router must end the call itself.
    expectDeliveryFailure(await postJsonRpc(url, token, {
      jsonrpc: "2.0", id: "build", method: "tools/call", params: { name: "effect", arguments: {} },
    }), "build");
    expect(executions).toBe(1);
    expect(failures).toEqual(["mcp_result_delivery_failed"]);

    // The result reaches the pending call but cannot be serialized onto the response.
    server.setOnToolCallArrived(token, () => "circular");
    const response = postJsonRpc(url, token, {
      jsonrpc: "2.0", id: "serialize", method: "tools/call", params: { name: "effect", arguments: {} },
    });
    await waitFor(() => server.hasPendingToolCall(token));
    const circular: Record<string, unknown> = { type: "text", text: "done" };
    circular.self = circular;
    server.resolveToolCall(token, "circular", { content: [circular as never], isError: false });
    expectDeliveryFailure(await response, "serialize");
    expect(server.hasPendingToolCall(token)).toBe(false);
    expect(server.failToolCall(token, "circular")).toBe(false);
    manager.cleanup();
  });
});

describe("executor session manager", () => {
  it("main session과 executor session을 token과 tool snapshot으로 분리한다", async () => {
    const registry = createMcpToolRegistry();
    const snapshotStore = createMcpToolSnapshotStore();
    const server = createServedMcpEndpoint({ toolSnapshotStore: snapshotStore });
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
    const server = createServedMcpEndpoint({ toolSnapshotStore: snapshotStore });
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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}
