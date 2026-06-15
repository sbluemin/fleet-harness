import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AcpContentBlock,
  AcpPromptResponse,
  CliType,
  ConnectResult,
  IUnifiedAgentClient,
  UnifiedClientOptions,
} from "@dotobokuri/core-unified-agent";

import {
  disconnectAll,
  executeWithPool,
  executorMcpRuntimeProviderRuntime,
  executorPortRuntime,
  listActivePoolKeys,
} from "@dotobokuri/core-agent";

import {
  buildCarrierExecutorPoolKey,
  buildTaskForceExecutorPoolKey,
  matchesCarrierPoolKey,
} from "../../src/dispatch/pool-key.js";
import { disconnectCarrierExecutorPools } from "../../src/store/pool-disconnect.js";

const { buildMock } = vi.hoisted(() => ({
  buildMock: vi.fn(),
}));

vi.mock("@dotobokuri/core-unified-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dotobokuri/core-unified-agent")>();
  return {
    ...actual,
    UnifiedAgent: {
      ...actual.UnifiedAgent,
      build: buildMock,
    },
    getEffort: () => ({ supported: false }),
    getProviderModels: () => ({ defaultModel: "fake-model", models: [{ modelId: "fake-model" }] }),
  };
});

class FakeClient extends EventEmitter implements IUnifiedAgentClient {
  disconnectCount = 0;
  state: "disconnected" | "ready" = "disconnected";
  sessionId: string | undefined;

  async connect(_options: UnifiedClientOptions): Promise<ConnectResult> {
    this.state = "ready";
    this.sessionId ??= `session-${fakeClients.length}`;
    return { session: { sessionId: this.sessionId } } as ConnectResult;
  }

  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    this.state = "disconnected";
  }

  async endSession(): Promise<void> {}

  async detectClis(): Promise<[]> {
    return [];
  }

  async sendMessage(_message: string | AcpContentBlock[]): Promise<AcpPromptResponse> {
    return {} as AcpPromptResponse;
  }

  async cancelPrompt(): Promise<void> {}

  getConnectionInfo(): ReturnType<IUnifiedAgentClient["getConnectionInfo"]> {
    return {
      state: this.state,
      sessionId: this.sessionId ?? null,
      cli: "codex",
      protocol: "codex-app-server",
    };
  }

  getCurrentSystemPrompt(): null {
    return null;
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

describe("carrier executor pool invalidation", () => {
  it("matches bare, namespaced, and taskforce pool keys for one carrier", () => {
    expect(matchesCarrierPoolKey("ohio", "ohio")).toBe(true);
    expect(matchesCarrierPoolKey("terminal-a:ohio", "ohio")).toBe(true);
    expect(matchesCarrierPoolKey(buildTaskForceExecutorPoolKey("ohio", "claude", undefined), "ohio")).toBe(true);
    expect(matchesCarrierPoolKey(buildTaskForceExecutorPoolKey("ohio", "codex", "terminal-a"), "ohio")).toBe(true);
    expect(matchesCarrierPoolKey("terminal-a:iowa", "ohio")).toBe(false);
    expect(matchesCarrierPoolKey(buildTaskForceExecutorPoolKey("iowa", "claude", "terminal-a"), "ohio")).toBe(false);
  });

  it("disconnects every active scoped pool key for the changed carrier", async () => {
    const ohioKeys = [
      buildCarrierExecutorPoolKey("ohio", undefined),
      buildCarrierExecutorPoolKey("ohio", "terminal-a"),
      buildTaskForceExecutorPoolKey("ohio", "claude", undefined),
      buildTaskForceExecutorPoolKey("ohio", "codex", "terminal-a"),
    ];
    const retainedKey = buildCarrierExecutorPoolKey("iowa", "terminal-a");

    for (const poolKey of [...ohioKeys, retainedKey]) {
      await executeWithPool(buildOptions(poolKey, poolKey.endsWith("iowa") ? "iowa" : "ohio"));
    }

    expect(listActivePoolKeys().sort()).toEqual([...ohioKeys, retainedKey].sort());

    await disconnectCarrierExecutorPools("ohio");

    expect(listActivePoolKeys()).toEqual([retainedKey]);
    expect(fakeClients.slice(0, 4).map((client) => client.disconnectCount)).toEqual([1, 1, 1, 1]);
    expect(fakeClients[4]!.disconnectCount).toBe(0);
  });
});

function buildOptions(poolKey: string, scopeId: string): Parameters<typeof executeWithPool>[0] {
  return {
    poolKey,
    scopeId,
    authEnvResolver: () => Promise.resolve({}),
    cliType: "codex" as CliType,
    request: "run",
    cwd: process.cwd(),
  };
}
