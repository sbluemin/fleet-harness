import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CliType,
  ConnectResult,
  IUnifiedAgentClient,
  AcpPromptResponse,
  AcpContentBlock,
  UnifiedClientOptions,
} from "@dotobokuri/core-unified-agent";
import {
  createMcpToolSnapshotStore,
  type AgentToolSpec,
  type McpRouterRuntime,
} from "@dotobokuri/core-mcp-server";

const buildMock = vi.fn();

vi.mock("@dotobokuri/core-unified-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dotobokuri/core-unified-agent")>();
  return {
    ...actual,
    UnifiedAgent: {
      ...actual.UnifiedAgent,
      build: buildMock,
    },
    getEffort: () => ({ supported: false }),
    getProviderModels: () => ({ defaultModel: "fake-model" }),
  };
});

const { executeOneShot, executeWithPool, disconnectAll, getSessionIdFor } = await import("../src/index.js");
const { executorMcpRuntimeProviderRuntime, executorPortRuntime } = await import("../src/executor-port.js");

class FakeClient extends EventEmitter implements IUnifiedAgentClient {
  readonly connectCalls: UnifiedClientOptions[] = [];
  readonly messages: string[] = [];
  disconnectCount = 0;
  cancelCount = 0;
  state: "disconnected" | "ready" = "disconnected";
  sessionId: string | undefined;
  currentSystemPrompt: string | undefined;
  nextConnectError: Error | undefined;
  connectGate: Promise<void> | undefined;
  sendGate: Promise<void> | undefined;

  async connect(options: UnifiedClientOptions): Promise<ConnectResult> {
    this.connectCalls.push({ ...options });
    await this.connectGate;
    if (this.nextConnectError) {
      const err = this.nextConnectError;
      this.nextConnectError = undefined;
      throw err;
    }
    this.state = "ready";
    this.currentSystemPrompt = options.systemPrompt;
    this.sessionId = options.sessionId ?? this.sessionId ?? `session-${fakeClients.indexOf(this) + 1}`;
    return { session: { sessionId: this.sessionId } } as ConnectResult;
  }

  async disconnect(): Promise<void> {
    this.disconnectCount++;
    this.state = "disconnected";
  }

  async endSession(): Promise<void> {}

  async detectClis(): Promise<[]> {
    return [];
  }

  async sendMessage(message: string | AcpContentBlock[]): Promise<AcpPromptResponse> {
    this.messages.push(typeof message === "string" ? message : JSON.stringify(message));
    await this.sendGate;
    return {} as AcpPromptResponse;
  }

  async cancelPrompt(): Promise<void> {
    this.cancelCount++;
  }

  getConnectionInfo(): ReturnType<IUnifiedAgentClient["getConnectionInfo"]> {
    return {
      state: this.state,
      sessionId: this.sessionId ?? null,
      cli: "codex",
      protocol: "codex-app-server",
    };
  }

  getCurrentSystemPrompt(): string | null {
    return this.currentSystemPrompt ?? null;
  }

  async setModel(): Promise<void> {}

  async setConfigOption(): Promise<void> {}

  async setMode(): Promise<void> {}

  async setYoloMode(): Promise<void> {}

  getAvailableModes(): [] {
    return [];
  }

  getAvailableModels(): null {
    return null;
  }

  async loadSession(): Promise<void> {}

  async resetSession(): Promise<ConnectResult> {
    return { session: { sessionId: this.sessionId } } as ConnectResult;
  }
}

const fakeClients: FakeClient[] = [];

describe("executeWithPool in-memory reuse", () => {
  beforeEach(async () => {
    await disconnectAll();
    fakeClients.length = 0;
    buildMock.mockClear();
    buildMock.mockImplementation(() => {
      const client = new FakeClient();
      fakeClients.push(client);
      return Promise.resolve(client);
    });
    executorPortRuntime.register({
      getScopeExternalMcpServerIds: () => [],
      getExecutorMcpTools: () => [],
    });
    executorMcpRuntimeProviderRuntime.register({
      getExecutorMcpRouterRuntimes: () => [],
    });
  });

  it("같은 poolKey는 살아 있는 pooled client를 재사용한다", async () => {
    await executeWithPool(buildOptions("first"));
    await executeWithPool(buildOptions("second"));

    expect(buildMock).toHaveBeenCalledTimes(1);
    expect(fakeClients[0]!.connectCalls).toHaveLength(1);
    expect(fakeClients[0]!.messages).toEqual(["first", "second"]);
  });

  it("busy entry가 있으면 풀을 확장하고, 이후 두 entry 모두 재사���한다", async () => {
    let releaseFirst!: () => void;
    buildMock.mockImplementation(() => {
      const client = new FakeClient();
      fakeClients.push(client);
      if (fakeClients.length === 1) {
        client.sendGate = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve(client);
    });

    const first = executeWithPool(buildOptions("first"));
    await vi.waitFor(() => expect(fakeClients[0]?.messages).toEqual(["first"]));
    const second = await executeWithPool(buildOptions("second"));
    releaseFirst();
    await first;

    expect(second.status).toBe("done");
    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(fakeClients[1]!.messages).toEqual(["second"]);
    // 확장된 두 번째 entry는 disconnect 되지 않고 풀에 유지된다
    expect(fakeClients[1]!.disconnectCount).toBe(0);

    // 이후 호출은 기존 entry 중 하나를 재사용한��
    await executeWithPool(buildOptions("third"));
    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(fakeClients[0]!.messages).toEqual(["first", "third"]);
  });

  it("동시에 busy인 풀을 확장한 뒤, 모두 idle이면 cleanIdle로 축소한다", async () => {
    const { cleanIdle } = await import("../src/index.js");
    let releaseFirst!: () => void;
    buildMock.mockImplementation(() => {
      const client = new FakeClient();
      fakeClients.push(client);
      if (fakeClients.length === 1) {
        client.sendGate = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve(client);
    });

    const first = executeWithPool(buildOptions("first"));
    await vi.waitFor(() => expect(fakeClients[0]?.messages).toEqual(["first"]));
    await executeWithPool(buildOptions("second"));
    releaseFirst();
    await first;

    expect(buildMock).toHaveBeenCalledTimes(2);
    // 둘 다 idle 상태 — cleanIdle 호출 시 모두 정리
    cleanIdle();
    expect(fakeClients[0]!.disconnectCount).toBe(1);
    expect(fakeClients[1]!.disconnectCount).toBe(1);

    // 풀이 비었으므로 새 client 생성
    await executeWithPool(buildOptions("fourth"));
    expect(buildMock).toHaveBeenCalledTimes(3);
  });

  it("system prompt drift는 live entry를 폐기하고 새 client를 만든다", async () => {
    await executeWithPool(buildOptions("first", { connectSystemPrompt: "A" }));
    await executeWithPool(buildOptions("second", { connectSystemPrompt: "B" }));

    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(fakeClients[0]!.disconnectCount).toBe(1);
    expect(fakeClients[1]!.messages).toEqual(["second"]);
  });

  it("builtin external MCP signature drift는 live entry를 폐기한다", async () => {
    let externalIds: readonly string[] = [];
    executorPortRuntime.register({
      getScopeExternalMcpServerIds: () => externalIds,
      getExecutorMcpTools: () => [],
    });

    await executeWithPool(buildOptions("first"));
    externalIds = ["grep_app"];
    await executeWithPool(buildOptions("second"));

    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(fakeClients[0]!.disconnectCount).toBe(1);
  });

  it("internal executor MCP tool whitelist shrink는 pooled client를 재사용하지 않는다", async () => {
    const runtime = createFakeMcpRuntime();
    let executorTools: readonly AgentToolSpec[] = [buildToolSpec("carrier_jobs")];
    executorPortRuntime.register({
      getScopeExternalMcpServerIds: () => [],
      getExecutorMcpTools: () => executorTools,
    });
    executorMcpRuntimeProviderRuntime.register({
      getExecutorMcpRouterRuntimes: () => [{ name: "carrier", runtime }],
    });

    await executeWithPool(buildOptions("first"));
    const firstToken = extractMcpToken(fakeClients[0]!.connectCalls[0]!);

    expect(runtime.snapshotStore.getToolNamesForSession(firstToken)).toEqual(new Set(["carrier_jobs"]));

    executorTools = [];
    await executeWithPool(buildOptions("second"));

    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(fakeClients[0]!.disconnectCount).toBe(1);
    expect(runtime.snapshotStore.getToolNamesForSession(firstToken)).toEqual(new Set());
    expect(fakeClients[1]!.connectCalls[0]!.mcpServers).toBeUndefined();
    expect(fakeClients[1]!.messages).toEqual(["second"]);
  });

  it("internal executor MCP tool schema drift는 pooled client를 재사용하지 않는다", async () => {
    const runtime = createFakeMcpRuntime();
    let executorTools: readonly AgentToolSpec[] = [
      buildToolSpec("carrier_jobs", { type: "object", properties: { action: { type: "string" } } }),
    ];
    executorPortRuntime.register({
      getScopeExternalMcpServerIds: () => [],
      getExecutorMcpTools: () => executorTools,
    });
    executorMcpRuntimeProviderRuntime.register({
      getExecutorMcpRouterRuntimes: () => [{ name: "carrier", runtime }],
    });

    await executeWithPool(buildOptions("first"));
    executorTools = [
      buildToolSpec("carrier_jobs", { type: "object", properties: { job_id: { type: "string" } } }),
    ];
    await executeWithPool(buildOptions("second"));

    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(fakeClients[0]!.disconnectCount).toBe(1);
    expect(fakeClients[1]!.messages).toEqual(["second"]);
  });

  it("dead-session resume 실패는 durable store 없이 sessionId를 지우고 재시도한다", async () => {
    await executeWithPool(buildOptions("first"));
    fakeClients[0]!.state = "disconnected";
    buildMock.mockImplementation(() => {
      const client = new FakeClient();
      fakeClients.push(client);
      if (fakeClients.length === 2) client.nextConnectError = new Error("session not found");
      return Promise.resolve(client);
    });

    await executeWithPool(buildOptions("second"));

    expect(buildMock).toHaveBeenCalledTimes(3);
    expect(fakeClients[1]!.connectCalls[0]!.sessionId).toBe("session-1");
    expect(fakeClients[2]!.connectCalls[0]!.sessionId).toBeUndefined();
    expect(fakeClients[2]!.messages).toEqual(["second"]);
  });

  it("getSessionIdFor는 stale pooled client를 제거하고 undefined를 반환한다", async () => {
    await executeWithPool(buildOptions("first"));
    fakeClients[0]!.state = "disconnected";

    expect(getSessionIdFor("carrier-a")).toBeUndefined();

    await executeWithPool(buildOptions("second"));

    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(fakeClients[1]!.connectCalls[0]!.sessionId).toBeUndefined();
    expect(fakeClients[1]!.messages).toEqual(["second"]);
  });

  it("getSessionIdFor는 busy connecting entry를 제거하지 않는다", async () => {
    let releaseConnect!: () => void;
    buildMock.mockImplementation(() => {
      const client = new FakeClient();
      fakeClients.push(client);
      if (fakeClients.length === 1) {
        client.connectGate = new Promise<void>((resolve) => {
          releaseConnect = resolve;
        });
      }
      return Promise.resolve(client);
    });

    const first = executeWithPool(buildOptions("first"));
    await vi.waitFor(() => expect(fakeClients[0]?.connectCalls).toHaveLength(1));

    expect(getSessionIdFor("carrier-a")).toBeUndefined();

    releaseConnect();
    await first;
    await executeWithPool(buildOptions("second"));

    expect(buildMock).toHaveBeenCalledTimes(1);
    expect(fakeClients[0]!.messages).toEqual(["first", "second"]);
  });

  it("executeOneShot은 fresh client를 만들고 매번 disconnect한다", async () => {
    await executeOneShot(buildOptions("first"));
    await executeOneShot(buildOptions("second"));

    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(fakeClients[0]!.disconnectCount).toBe(1);
    expect(fakeClients[1]!.disconnectCount).toBe(1);
  });
});

function buildOptions(
  request: string,
  overrides: Partial<Parameters<typeof executeWithPool>[0]> = {},
): Parameters<typeof executeWithPool>[0] {
  return {
    poolKey: "carrier-a",
    scopeId: "carrier-a",
    authEnvResolver: () => Promise.resolve({}),
    cliType: "codex" as CliType,
    request,
    cwd: process.cwd(),
    ...overrides,
  };
}

function buildToolSpec(id: string, parameters: unknown = { type: "object", properties: {} }): AgentToolSpec {
  return {
    id,
    tag: id,
    title: id,
    description: `${id} description`,
    promptSnippet: `${id} prompt`,
    whenToUse: [],
    whenNotToUse: [],
    usageGuidelines: [],
    parameters,
    execute: () => Promise.resolve({ content: [{ type: "text", text: "ok" }], isError: false }),
  };
}

function createFakeMcpRuntime(): McpRouterRuntime {
  const snapshotStore = createMcpToolSnapshotStore();
  return {
    snapshotStore,
    registry: {
      invoke: () => Promise.resolve({ content: [{ type: "text", text: "ok" }], isError: false }),
    },
    server: {
      start: () => Promise.resolve("http://127.0.0.1:54321/mcp"),
      stop: () => Promise.resolve(),
      setOnToolCallArrived: () => {},
      resolveNextToolCall: () => {},
      hasPendingToolCall: () => false,
      clearPendingForSession: () => {},
    },
  } as unknown as McpRouterRuntime;
}

function extractMcpToken(connectOptions: UnifiedClientOptions): string {
  const headerValue = connectOptions.mcpServers?.[0]?.headers?.find((header) => header.name === "Authorization")?.value;
  expect(headerValue).toMatch(/^Bearer /);
  return headerValue!.replace(/^Bearer /, "");
}
