import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CliType,
  ConnectResult,
  IUnifiedAgentClient,
  AcpPromptResponse,
  AcpContentBlock,
  UnifiedClientOptions,
} from "@dotobokuri/fleet-unified-agent";

const buildMock = vi.fn();

vi.mock("@dotobokuri/fleet-unified-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dotobokuri/fleet-unified-agent")>();
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

const { executeOneShot, executeWithPool, disconnectAll } = await import("../../src/agent/index.js");
const { executorPortRuntime } = await import("../../src/agent/executor-port.js");

class FakeClient extends EventEmitter implements IUnifiedAgentClient {
  readonly connectCalls: UnifiedClientOptions[] = [];
  readonly messages: string[] = [];
  disconnectCount = 0;
  cancelCount = 0;
  state: "disconnected" | "ready" = "disconnected";
  sessionId: string | undefined;
  currentSystemPrompt: string | undefined;
  nextConnectError: Error | undefined;
  sendGate: Promise<void> | undefined;

  async connect(options: UnifiedClientOptions): Promise<ConnectResult> {
    this.connectCalls.push({ ...options });
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
      getCarrierExternalMcpServerIds: () => [],
      getExecutorMcpRouterRuntimes: () => [],
      getExecutorMcpTools: () => [],
    });
  });

  it("같은 poolKey는 살아 있는 pooled client를 재사용한다", async () => {
    await executeWithPool(buildOptions("first"));
    await executeWithPool(buildOptions("second"));

    expect(buildMock).toHaveBeenCalledTimes(1);
    expect(fakeClients[0]!.connectCalls).toHaveLength(1);
    expect(fakeClients[0]!.messages).toEqual(["first", "second"]);
  });

  it("busy entry는 임시 client를 사용하고 정리하며 기존 entry를 보존한다", async () => {
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
    expect(fakeClients[1]!.disconnectCount).toBe(1);

    await executeWithPool(buildOptions("third"));
    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(fakeClients[0]!.messages).toEqual(["first", "third"]);
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
      getCarrierExternalMcpServerIds: () => externalIds,
      getExecutorMcpRouterRuntimes: () => [],
      getExecutorMcpTools: () => [],
    });

    await executeWithPool(buildOptions("first"));
    externalIds = ["grep_app"];
    await executeWithPool(buildOptions("second"));

    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(fakeClients[0]!.disconnectCount).toBe(1);
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
    carrierId: "carrier-a",
    cliType: "codex" as CliType,
    request,
    cwd: process.cwd(),
    ...overrides,
  };
}
