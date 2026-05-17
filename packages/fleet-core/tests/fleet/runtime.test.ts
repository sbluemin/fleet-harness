/**
 * runtime 단위 테스트
 *
 * internal/agent/runtime.ts의 핵심 계약을 검증합니다:
 * - initRuntime이 `.data` 디렉토리를 생성하는지
 * - 모델 설정 load/save가 올바른 경로에서 동작하는지
 * - 세션 매핑이 initRuntime → onHostSessionChange 흐름으로 동작하는지
 * - 미초기화 상태에서 graceful fallback이 동작하는지
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { UnifiedAgent, type IUnifiedAgentClient, type UnifiedClientOptions } from "@sbluemin/fleet-unified-agent";

import {
  CARRIER_SESSION_CUSTOM_TYPE,
  HOST_SESSION_CUSTOM_TYPE,
  captureSessionMappingCommitToken,
  initRuntime,
  onHostSessionChange,
  getCarrierSessionStore,
  getSessionId,
  getDataDir,
  getHostSessionStore,
  flushSessionMappings,
  type SessionPersistencePort,
} from "../../src/admiral/agent/internal/session-runtime.js";
import {
  initStore,
  loadModels as getModelConfig,
  saveModels as saveSelectedModels,
  reconcileActiveModelSelections,
  updateModelSelection,
  updateAllModelSelections,
  savePerCliSettings,
  loadCliTypeOverrides,
  updateCliTypeOverride,
} from "../../src/admiral/store/index.js";
import { executeWithPool, disconnectAll } from "../../src/admiral/agent/index.js";

vi.mock("@sbluemin/fleet-unified-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sbluemin/fleet-unified-agent")>();
  return {
    ...actual,
    UnifiedAgent: {
      ...actual.UnifiedAgent,
      build: vi.fn(),
    },
  };
});

let tmpDir: string;

interface TestCustomEntry {
  type: "custom";
  customType: string;
  data?: unknown;
}

type MockClient = IUnifiedAgentClient & {
  connectCalls: UnifiedClientOptions[];
  disconnectCount: number;
};

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "runtime-test-"));
}

function rmDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createMockClient(
  sessionId: string,
  options: {
    initialState?: "ready" | "disconnected";
    initialSystemPrompt?: string;
    connectImpl?: (opts: UnifiedClientOptions, client: MockClient) => Promise<{ session?: { sessionId?: string } }>;
    sendImpl?: (client: MockClient) => Promise<void>;
    postSendSessionId?: string;
  } = {},
): MockClient {
  let state = options.initialState ?? "disconnected";
  let currentSystemPrompt = options.initialSystemPrompt;
  let currentSessionId = sessionId;
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const client = {
    connectCalls: [] as UnifiedClientOptions[],
    disconnectCount: 0,
    async connect(connectOptions: UnifiedClientOptions) {
      client.connectCalls.push(connectOptions);
      if (options.connectImpl) return options.connectImpl(connectOptions, client);
      state = "ready";
      currentSystemPrompt = connectOptions.systemPrompt;
      currentSessionId = sessionId;
      return { session: { sessionId: currentSessionId } };
    },
    async sendMessage() {
      await options.sendImpl?.(client);
      if (options.postSendSessionId) currentSessionId = options.postSendSessionId;
    },
    async deliverToolResults() {},
    async cancelPrompt() {},
    async disconnect() {
      client.disconnectCount += 1;
      state = "disconnected";
    },
    getConnectionInfo() {
      return { state, sessionId: state === "disconnected" ? undefined : currentSessionId };
    },
    getCurrentSystemPrompt() {
      return currentSystemPrompt;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      let eventHandlers = handlers.get(event);
      if (!eventHandlers) {
        eventHandlers = new Set();
        handlers.set(event, eventHandlers);
      }
      eventHandlers.add(handler);
      return client;
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      handlers.get(event)?.delete(handler);
      return client;
    },
    removeAllListeners() {
      handlers.clear();
      return client;
    },
  } as unknown as MockClient;
  return client;
}

function createSessionPort(sessionId: string, initialEntries: TestCustomEntry[] = []): SessionPersistencePort & {
  entries: TestCustomEntry[];
  flushCount: number;
} {
  const port = {
    entries: [...initialEntries],
    flushCount: 0,
    getSessionId() {
      return sessionId;
    },
    getEntries() {
      return port.entries;
    },
    appendCustomEntry(customType: string, data?: unknown) {
      port.entries.push({ type: "custom", customType, data });
      return `entry-${port.entries.length}`;
    },
    flush() {
      port.flushCount += 1;
    },
  };
  return port;
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  vi.mocked(UnifiedAgent.build).mockReset();
});

afterEach(async () => {
  await disconnectAll();
  vi.mocked(UnifiedAgent.build).mockReset();
  rmDir(tmpDir);
});

describe("initRuntime", () => {
  it("존재하지 않는 dataDir을 자동으로 생성한다", () => {
    const deepDir = path.join(tmpDir, "core", ".data");
    expect(fs.existsSync(deepDir)).toBe(false);

    initRuntime(deepDir);

    expect(fs.existsSync(deepDir)).toBe(true);
    expect(getDataDir()).toBe(deepDir);
  });

  it("이미 존재하는 dataDir에 대해 에러 없이 동작한다", () => {
    initRuntime(tmpDir);
    initRuntime(tmpDir);
    expect(getDataDir()).toBe(tmpDir);
  });
});

describe("getModelConfig / saveSelectedModels", () => {
  it("초기 상태에서 빈 객체를 반환한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    expect(getModelConfig()).toEqual({});
  });

  it("저장된 모델 설정을 올바르게 로드한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    const config = { genesis: { model: "opus" }, sentinel: { model: "gpt-5" } };
    saveSelectedModels(config);

    const loaded = getModelConfig();
    expect(loaded.genesis?.model).toBe("opus");
    expect(loaded.sentinel?.model).toBe("gpt-5");
  });

  it("initRuntime 없이 호출하면 빈 객체를 반환한다 (graceful)", () => {
    const nonExistentDir = path.join(tmpDir, "nonexistent", "deep");
    initRuntime(nonExistentDir);
    initStore(nonExistentDir);
    expect(getModelConfig()).toEqual({});
  });

  it("새로 생성된 dataDir에서 첫 모델 저장이 ENOENT 없이 성공한다", () => {
    const deepDir = path.join(tmpDir, "brand", "new", "path");
    initRuntime(deepDir);
    initStore(deepDir);

    expect(() => {
      saveSelectedModels({ vanguard: { model: "gemini-3" } });
    }).not.toThrow();

    const filePath = path.join(deepDir, "states.json");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("updateModelSelection은 cliType이 아닌 carrierId 키로 저장한다", async () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    onHostSessionChange("model-by-carrier");
    const port = createSessionPort("model-by-carrier");
    onHostSessionChange("model-by-carrier", port);
    const store = getCarrierSessionStore();
    store.set("vanguard", "vanguard-session", captureSessionMappingCommitToken());

    await updateModelSelection("vanguard", { model: "gemini-2.5-pro" });

    const loaded = getModelConfig();
    expect(loaded.vanguard?.model).toBe("gemini-2.5-pro");
    expect(store.get("vanguard")).toBeUndefined();
  });

  it("updateAllModelSelections은 carrierId 키들을 그대로 저장하고 세션을 정리한다", async () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    onHostSessionChange("bulk-models");
    const port = createSessionPort("bulk-models");
    onHostSessionChange("bulk-models", port);
    const store = getCarrierSessionStore();
    store.set("vanguard", "vanguard-session", captureSessionMappingCommitToken());
    store.set("sentinel", "sentinel-session", captureSessionMappingCommitToken());

    await updateAllModelSelections({
      vanguard: { model: "gemini-2.5-flash" },
      sentinel: { model: "gpt-5" },
    });

    const loaded = getModelConfig();
    expect(loaded.vanguard?.model).toBe("gemini-2.5-flash");
    expect(loaded.sentinel?.model).toBe("gpt-5");
    expect(store.get("vanguard")).toBeUndefined();
    expect(store.get("sentinel")).toBeUndefined();
  });

  it("reconcileActiveModelSelections는 현재 cliType 기준으로 top-level 선택을 재수화한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    saveSelectedModels({
      vanguard: {
        model: "gpt-5.4-mini",
        effort: "xhigh",
        perCliSettings: {
          codex: {
            model: "gpt-5.4-mini",
            effort: "xhigh",
          },
          gemini: {
            model: "gemini-3.1-pro-preview",
          },
        },
      },
    });

    const changed = reconcileActiveModelSelections({ vanguard: "gemini" as any });
    const loaded = getModelConfig();

    expect(changed).toBe(true);
    expect(loaded.vanguard?.model).toBe("gemini-3.1-pro-preview");
    expect(loaded.vanguard?.effort).toBeUndefined();
    expect(loaded.vanguard?.perCliSettings?.gemini?.model).toBe("gemini-3.1-pro-preview");
  });

  it("reconcileActiveModelSelections는 현재 top-level 선택이 유효하면 유지한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    saveSelectedModels({
      genesis: {
        model: "gpt-5.4",
        effort: "high",
        perCliSettings: {
          codex: {
            model: "gpt-5.4-mini",
            effort: "medium",
          },
        },
      },
    });

    const changed = reconcileActiveModelSelections({ genesis: "codex" as any });
    const loaded = getModelConfig();

    expect(changed).toBe(false);
    expect(loaded.genesis?.model).toBe("gpt-5.4");
    expect(loaded.genesis?.effort).toBe("high");
  });

  it("단일 cliType override 저장은 기존 다른 override를 보존한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);

    updateCliTypeOverride("alpha", "codex", "claude");
    updateCliTypeOverride("beta", "gemini", "codex");

    expect(loadCliTypeOverrides()).toEqual({
      alpha: "codex",
      beta: "gemini",
    });
  });

  it("단일 cliType override 삭제는 다른 override를 보존한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);

    updateCliTypeOverride("alpha", "codex", "claude");
    updateCliTypeOverride("beta", "gemini", "codex");
    updateCliTypeOverride("alpha", "claude", "claude");

    expect(loadCliTypeOverrides()).toEqual({
      beta: "gemini",
    });
  });

  it("모델 저장은 기존 cliTypeOverrides를 보존한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);

    updateCliTypeOverride("alpha", "codex", "claude");
    saveSelectedModels({ alpha: { model: "gpt-5.4" } });

    expect(loadCliTypeOverrides()).toEqual({ alpha: "codex" });
  });

  it("per-CLI 설정 저장은 기존 cliTypeOverrides를 보존한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);

    updateCliTypeOverride("alpha", "codex", "claude");
    savePerCliSettings("alpha", "claude", { model: "claude-opus-4-7" });

    expect(loadCliTypeOverrides()).toEqual({ alpha: "codex" });
  });

  it("죽은 owner의 stale lock은 owner metadata 확인 후 회수한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    const lockDir = path.join(tmpDir, "states.json.lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 999999,
        hostname: os.hostname(),
        startedAt: Date.now() - 60000,
      }),
      "utf-8",
    );

    updateCliTypeOverride("alpha", "codex", "claude");

    expect(loadCliTypeOverrides()).toEqual({ alpha: "codex" });
    expect(fs.existsSync(lockDir)).toBe(false);
  });
});

describe("세션 매핑 (sessionStore + onHostSessionChange)", () => {
  it("호스트 세션 변경 후 세션 매핑이 복원된다", () => {
    initRuntime(tmpDir);

    const port1 = createSessionPort("test-session-1");
    const port2 = createSessionPort("test-session-2");
    onHostSessionChange("test-session-1", port1);
    const store = getCarrierSessionStore();
    store.set("genesis" as any, "sub-session-abc", captureSessionMappingCommitToken());
    store.commitSet("genesis" as any, "sub-session-abc", captureSessionMappingCommitToken());
    expect(store.get("genesis" as any)).toBe("sub-session-abc");

    onHostSessionChange("test-session-2", port2);
    expect(store.get("genesis" as any)).toBeUndefined();

    onHostSessionChange("test-session-1", port1);
    expect(store.get("genesis" as any)).toBe("sub-session-abc");
  });

  it("getSessionId로 CLI별 sessionId를 조회할 수 있다", () => {
    initRuntime(tmpDir);
    const port = createSessionPort("sid-1");
    onHostSessionChange("sid-1", port);
    const store = getCarrierSessionStore();
    store.set("sentinel" as any, "sentinel-session-xyz", captureSessionMappingCommitToken());

    expect(getSessionId("sentinel" as any)).toBe("sentinel-session-xyz");
    expect(getSessionId("genesis" as any)).toBeUndefined();
  });

  it("미초기화 상태에서 getSessionStore는 noop store를 반환한다", () => {
    const freshDir = path.join(tmpDir, "fresh");
    initRuntime(freshDir);
    const store = getCarrierSessionStore();
    expect(store.get("genesis" as any)).toBeUndefined();
    expect(store.set("genesis" as any, "some-id", captureSessionMappingCommitToken())).toBe(false);
  });

  it("set은 메모리만 갱신하고 commitSet은 coding-agent JSONL custom entry로 저장한다", () => {
    initRuntime(tmpDir);
    const port = createSessionPort("persist-test");
    onHostSessionChange("persist-test", port);
    const store = getCarrierSessionStore();
    store.set("vanguard" as any, "gem-sess-1", captureSessionMappingCommitToken());

    expect(store.get("vanguard" as any)).toBe("gem-sess-1");
    expect(port.entries).toEqual([]);

    store.commitSet("vanguard" as any, "gem-sess-1", captureSessionMappingCommitToken());

    expect(fs.existsSync(path.join(tmpDir, "session-maps", "persist-test.json"))).toBe(false);
    expect(port.entries).toEqual([
      {
        type: "custom",
        customType: CARRIER_SESSION_CUSTOM_TYPE,
        data: { action: "set", key: "vanguard", sessionId: "gem-sess-1" },
      },
    ]);
  });

  it("호스트와 캐리어 세션 매핑은 customType과 key space를 분리한다", () => {
    initRuntime(tmpDir);
    const port = createSessionPort("separated");
    onHostSessionChange("separated", port);

    getHostSessionStore().set("codex", "host-session", captureSessionMappingCommitToken());
    getCarrierSessionStore().set("codex", "carrier-session", captureSessionMappingCommitToken());
    getHostSessionStore().commitSet("codex", "host-session", captureSessionMappingCommitToken());
    getCarrierSessionStore().commitSet("codex", "carrier-session", captureSessionMappingCommitToken());

    expect(getHostSessionStore().get("codex")).toBe("host-session");
    expect(getCarrierSessionStore().get("codex")).toBe("carrier-session");
    expect(port.entries.map((entry) => entry.customType)).toEqual([
      HOST_SESSION_CUSTOM_TYPE,
      CARRIER_SESSION_CUSTOM_TYPE,
    ]);
  });

  it("commitSet/clear는 의미 있는 durable 변경에만 custom entry를 추가한다", () => {
    initRuntime(tmpDir);
    const port = createSessionPort("idempotent");
    onHostSessionChange("idempotent", port);
    const store = getCarrierSessionStore();

    store.set("taskforce:one", "sid-1", captureSessionMappingCommitToken());
    expect(port.entries).toHaveLength(0);
    store.commitSet("taskforce:one", "sid-1", captureSessionMappingCommitToken());
    store.commitSet("taskforce:one", "sid-1", captureSessionMappingCommitToken());
    store.set("taskforce:one", "sid-1", captureSessionMappingCommitToken());
    store.clear("missing");
    store.clear("taskforce:one");
    store.clear("taskforce:one");

    expect(port.entries).toHaveLength(2);
    expect(port.entries[0]?.data).toEqual({ action: "set", key: "taskforce:one", sessionId: "sid-1" });
    expect(port.entries[1]?.data).toEqual({ action: "clear", key: "taskforce:one" });
  });

  it("stale commit token은 다른 host session port에 mapping을 append하거나 주입하지 않는다", () => {
    initRuntime(tmpDir);
    const originPort = createSessionPort("origin-session");
    const nextPort = createSessionPort("next-session");
    onHostSessionChange("origin-session", originPort);
    const originToken = captureSessionMappingCommitToken();
    const store = getCarrierSessionStore();
    store.set("genesis", "origin-carrier-session", originToken);

    onHostSessionChange("next-session", nextPort);
    const committed = store.commitSet("genesis", "origin-carrier-session", originToken);

    expect(committed).toBe(false);
    expect(originPort.entries).toEqual([]);
    expect(nextPort.entries).toEqual([]);
    expect(store.get("genesis")).toBeUndefined();
  });

  it("append 실패 시 durableMap을 갱신하지 않아 같은 token으로 재시도할 수 있다", () => {
    initRuntime(tmpDir);
    const port = createSessionPort("retry-append");
    let appendEnabled = false;
    port.appendCustomEntry = (customType: string, data?: unknown) => {
      if (!appendEnabled) return "";
      port.entries.push({ type: "custom", customType, data });
      return `entry-${port.entries.length}`;
    };
    onHostSessionChange("retry-append", port);
    const token = captureSessionMappingCommitToken();
    const store = getCarrierSessionStore();
    store.set("sentinel", "retry-sid", token);

    expect(store.commitSet("sentinel", "retry-sid", token)).toBe(false);
    appendEnabled = true;
    expect(store.commitSet("sentinel", "retry-sid", token)).toBe(true);

    expect(port.entries.map((entry) => entry.data)).toEqual([
      { action: "set", key: "sentinel", sessionId: "retry-sid" },
    ]);
  });

  it("restore는 JSONL custom entry를 시간순 replay하고 malformed entry를 무시한다", () => {
    initRuntime(tmpDir);
    const port = createSessionPort("replay", [
      { type: "custom", customType: CARRIER_SESSION_CUSTOM_TYPE, data: { action: "set", key: "nimitz", sessionId: "sid-1" } },
      { type: "custom", customType: CARRIER_SESSION_CUSTOM_TYPE, data: { action: "set", key: "nimitz", sessionId: "sid-2" } },
      { type: "custom", customType: CARRIER_SESSION_CUSTOM_TYPE, data: { action: "set", key: "", sessionId: "bad" } },
      { type: "custom", customType: CARRIER_SESSION_CUSTOM_TYPE, data: { action: "clear", key: "nimitz" } },
      { type: "custom", customType: HOST_SESSION_CUSTOM_TYPE, data: { action: "set", key: "codex", sessionId: "host-sid" } },
    ]);

    onHostSessionChange("replay", port);

    expect(getCarrierSessionStore().get("nimitz")).toBeUndefined();
    expect(getHostSessionStore().get("codex")).toBe("host-sid");
  });

  it("fresh bind와 일반 set은 flush하지 않고 durable 변경 후 flush한다", () => {
    initRuntime(tmpDir);
    const port = createSessionPort("flush-policy");
    onHostSessionChange("flush-policy", port);
    expect(port.flushCount).toBe(0);

    getCarrierSessionStore().set("genesis", "sid-1", captureSessionMappingCommitToken());
    flushSessionMappings();
    expect(port.flushCount).toBe(0);

    getCarrierSessionStore().commitSet("genesis", "sid-1", captureSessionMappingCommitToken());
    flushSessionMappings();
    expect(port.flushCount).toBe(1);

    getCarrierSessionStore().clear("genesis");
    flushSessionMappings();

    expect(port.flushCount).toBe(2);
  });

  it("executor fresh connect는 send 완료 전 carrier mapping을 durable append하지 않는다", async () => {
    initRuntime(tmpDir);
    const port = createSessionPort("executor-pending");
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      const client = createMockClient("pending-sid", {
        sendImpl: async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseSend = release;
          });
        },
      });
      vi.mocked(UnifiedAgent.build).mockResolvedValue(client);
    });
    onHostSessionChange("executor-pending", port);

    const run = executeWithPool({
      poolKey: "genesis",
      cliType: "codex" as any,
      request: "first",
      cwd: tmpDir,
      connectSystemPrompt: "prompt",
    });
    await sendStarted;

    expect(getCarrierSessionStore().get("genesis")).toBe("pending-sid");
    expect(port.entries).toEqual([]);

    releaseSend();
    await run;

    expect(port.entries.map((entry) => entry.data)).toContainEqual({
      action: "set",
      key: "genesis",
      sessionId: "pending-sid",
    });
  });

  it("executor connect completion 전에 host port가 바뀌면 pending carrier map을 오염시키지 않는다", async () => {
    initRuntime(tmpDir);
    const originPort = createSessionPort("executor-connect-origin");
    const nextPort = createSessionPort("executor-connect-next");
    let releaseConnect!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      const client = createMockClient("executor-connect-origin-sid", {
        connectImpl: async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseConnect = release;
          });
          return { session: { sessionId: "executor-connect-origin-sid" } };
        },
      });
      vi.mocked(UnifiedAgent.build).mockResolvedValue(client);
    });
    onHostSessionChange("executor-connect-origin", originPort);

    const run = executeWithPool({
      poolKey: "chronicle",
      cliType: "codex" as any,
      request: "first",
      cwd: tmpDir,
      connectSystemPrompt: "prompt",
    });
    await connectStarted;

    onHostSessionChange("executor-connect-next", nextPort);
    releaseConnect();
    await run;

    expect(originPort.entries).toEqual([]);
    expect(nextPort.entries).toEqual([]);
    expect(getCarrierSessionStore().get("chronicle")).toBeUndefined();
  });

  it("stale connect completion으로 채워진 pool entry를 다음 host session에서 재사용하지 않는다", async () => {
    initRuntime(tmpDir);
    const originPort = createSessionPort("executor-stale-pool-origin");
    const nextPort = createSessionPort("executor-stale-pool-next");
    let releaseConnect!: () => void;
    const staleClient = createMockClient("stale-pool-sid", {
      connectImpl: async () => {
        await new Promise<void>((release) => {
          releaseConnect = release;
        });
        return { session: { sessionId: "stale-pool-sid" } };
      },
    });
    const freshClient = createMockClient("fresh-pool-sid");
    vi.mocked(UnifiedAgent.build)
      .mockResolvedValueOnce(staleClient)
      .mockResolvedValueOnce(freshClient);
    onHostSessionChange("executor-stale-pool-origin", originPort);

    const staleRun = executeWithPool({
      poolKey: "tempest",
      cliType: "codex" as any,
      request: "first",
      cwd: tmpDir,
      connectSystemPrompt: "prompt",
    });
    await vi.waitFor(() => {
      expect(releaseConnect).toBeTypeOf("function");
    });
    onHostSessionChange("executor-stale-pool-next", nextPort);
    releaseConnect();
    await staleRun;

    expect(staleClient.disconnectCount).toBe(1);
    expect(getCarrierSessionStore().get("tempest")).toBeUndefined();

    await executeWithPool({
      poolKey: "tempest",
      cliType: "codex" as any,
      request: "second",
      cwd: tmpDir,
      connectSystemPrompt: "prompt",
    });

    expect(freshClient.connectCalls[0]?.sessionId).toBeUndefined();
    expect(getCarrierSessionStore().get("tempest")).toBe("fresh-pool-sid");
    expect(nextPort.entries.map((entry) => entry.data)).toContainEqual({
      action: "set",
      key: "tempest",
      sessionId: "fresh-pool-sid",
    });
    expect(nextPort.entries.map((entry) => entry.data)).not.toContainEqual({
      action: "set",
      key: "tempest",
      sessionId: "stale-pool-sid",
    });
  });

  it("executor post-send commit은 origin host port가 stale이면 폐기하고 새 port를 오염시키지 않는다", async () => {
    initRuntime(tmpDir);
    const originPort = createSessionPort("executor-origin");
    const nextPort = createSessionPort("executor-next");
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      const client = createMockClient("executor-origin-sid", {
        sendImpl: async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseSend = release;
          });
        },
      });
      vi.mocked(UnifiedAgent.build).mockResolvedValue(client);
    });
    onHostSessionChange("executor-origin", originPort);

    const run = executeWithPool({
      poolKey: "vanguard",
      cliType: "codex" as any,
      request: "first",
      cwd: tmpDir,
      connectSystemPrompt: "prompt",
    });
    await sendStarted;

    onHostSessionChange("executor-next", nextPort);
    releaseSend();
    await run;

    expect(originPort.entries).toEqual([]);
    expect(nextPort.entries).toEqual([]);
    expect(getCarrierSessionStore().get("vanguard")).toBeUndefined();
  });

  it("executor durable commit uses the post-send session ID when it changes", async () => {
    initRuntime(tmpDir);
    const port = createSessionPort("executor-post-send");
    const client = createMockClient("pre-send-sid", { postSendSessionId: "post-send-sid" });
    onHostSessionChange("executor-post-send", port);
    vi.mocked(UnifiedAgent.build).mockResolvedValue(client);

    await executeWithPool({
      poolKey: "sentinel",
      cliType: "codex" as any,
      request: "first",
      cwd: tmpDir,
      connectSystemPrompt: "prompt",
    });

    expect(getCarrierSessionStore().get("sentinel")).toBe("post-send-sid");
    expect(port.entries.map((entry) => entry.data)).toContainEqual({
      action: "set",
      key: "sentinel",
      sessionId: "post-send-sid",
    });
    expect(port.entries.map((entry) => entry.data)).not.toContainEqual({
      action: "set",
      key: "sentinel",
      sessionId: "pre-send-sid",
    });
  });

  it("executor systemPrompt drift 무효화는 clear 후 flush하고 disconnect한다", async () => {
    initRuntime(tmpDir);
    const port = createSessionPort("drift-flush");
    onHostSessionChange("drift-flush", port);
    const client = createMockClient("drift-session");
    vi.mocked(UnifiedAgent.build).mockResolvedValue(client);

    await executeWithPool({
      poolKey: "genesis",
      cliType: "codex" as any,
      request: "first",
      cwd: tmpDir,
      connectSystemPrompt: "old prompt",
    });

    expect(port.flushCount).toBe(1);
    expect(getCarrierSessionStore().get("genesis")).toBe("drift-session");

    await executeWithPool({
      poolKey: "genesis",
      cliType: "codex" as any,
      request: "second",
      cwd: tmpDir,
      connectSystemPrompt: "new prompt",
    });

    expect(port.flushCount).toBe(3);
    expect(client.disconnectCount).toBe(1);
    expect(port.entries.map((entry) => entry.data)).toContainEqual({ action: "clear", key: "genesis" });
  });

  it("executor dead-session fallback 무효화는 clear 후 flush하고 fresh connect한다", async () => {
    initRuntime(tmpDir);
    const port = createSessionPort("dead-session-flush");
    onHostSessionChange("dead-session-flush", port);
    getCarrierSessionStore().set("sentinel", "dead-sid", captureSessionMappingCommitToken());
    const deadClient = createMockClient("dead-sid", {
      connectImpl: async (connectOptions) => {
        if (connectOptions.sessionId === "dead-sid") throw new Error("session not found");
        return { session: { sessionId: "unexpected" } };
      },
    });
    const freshClient = createMockClient("fresh-sid");
    vi.mocked(UnifiedAgent.build)
      .mockResolvedValueOnce(deadClient)
      .mockResolvedValueOnce(freshClient);

    await executeWithPool({
      poolKey: "sentinel",
      cliType: "codex" as any,
      request: "recover",
      cwd: tmpDir,
      connectSystemPrompt: "prompt",
    });

    expect(port.flushCount).toBe(2);
    expect(deadClient.disconnectCount).toBe(1);
    expect(freshClient.connectCalls[0]?.sessionId).toBeUndefined();
    expect(getCarrierSessionStore().get("sentinel")).toBe("fresh-sid");
    expect(port.entries.map((entry) => entry.data)).toContainEqual({ action: "clear", key: "sentinel" });
  });

  it("legacy session-maps 폴더는 initRuntime에서 1회 삭제되고 마이그레이션하지 않는다", () => {
    const legacyDir = path.join(tmpDir, "session-maps");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "legacy.json"), JSON.stringify({ genesis: "sid" }), "utf-8");

    initRuntime(tmpDir);

    expect(fs.existsSync(legacyDir)).toBe(false);
  });
});
