import { beforeEach, describe, expect, it, vi } from "vitest";

import { UnifiedAgent, type IUnifiedAgentClient, type UnifiedClientOptions } from "@sbluemin/fleet-unified-agent";

import { ensure, resolveSession, sendMessage } from "../../src/admiral/agent/session.js";
import {
  getHostSessionStore,
  HOST_SESSION_CUSTOM_TYPE,
  initRuntime,
  onHostSessionChange,
  type SessionPersistencePort,
} from "../../src/admiral/agent/internal/session-runtime.js";

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

interface TestCustomEntry {
  type: "custom";
  customType: string;
  data?: unknown;
}

type MockClient = IUnifiedAgentClient & {
  connectCalls: UnifiedClientOptions[];
  sendCount: number;
};

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

function createMockClient(
  sessionId: string,
  options: {
    connectImpl?: () => Promise<void>;
    sendImpl?: () => Promise<void>;
    postSendSessionId?: string;
  } = {},
): MockClient {
  let state: "ready" | "disconnected" = "disconnected";
  let currentSessionId = sessionId;
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const client = {
    connectCalls: [] as UnifiedClientOptions[],
    sendCount: 0,
    async connect(connectOptions: UnifiedClientOptions) {
      client.connectCalls.push(connectOptions);
      await options.connectImpl?.();
      state = "ready";
      currentSessionId = sessionId;
      return { session: { sessionId: currentSessionId } };
    },
    async sendMessage() {
      client.sendCount += 1;
      await options.sendImpl?.();
      if (options.postSendSessionId) currentSessionId = options.postSendSessionId;
    },
    async deliverToolResults() {},
    async cancelPrompt() {},
    async disconnect() {
      state = "disconnected";
    },
    async setModel() {},
    getConnectionInfo() {
      return { state, sessionId: state === "ready" ? currentSessionId : undefined };
    },
    getCurrentSystemPrompt() {
      return undefined;
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

beforeEach(() => {
  vi.mocked(UnifiedAgent.build).mockReset();
  initRuntime("/tmp/fleet-agent-session-test");
});

describe("admiral.agent.session", () => {
  describe("resolveSession()", () => {
    it("빈 문자열 sessionId는 undefined를 반환한다", () => {
      expect(resolveSession("")).toBeUndefined();
    });

    it("존재하지 않는 sessionId는 undefined를 반환한다", () => {
      expect(resolveSession("nonexistent-session-id")).toBeUndefined();
    });
  });

  describe("durable host session mapping", () => {
    it("fresh ensure는 in-memory mapping만 만들고 첫 send 이후 durable mapping을 append한다", async () => {
      const port = createSessionPort("pi-session");
      const client = createMockClient("host-sid-1");
      onHostSessionChange("pi-session", port);
      vi.mocked(UnifiedAgent.build).mockResolvedValue(client);

      const handle = await ensure({
        cli: "codex" as any,
        backendModel: "gpt-test",
        scopeKey: "fresh-ensure",
        cwd: "/tmp",
      });

      expect(handle.sessionId).toBe("host-sid-1");
      expect(port.entries).toEqual([]);

      await sendMessage(handle, { userRequest: "hello" });

      expect(client.sendCount).toBe(1);
      expect(port.entries).toEqual([
        {
          type: "custom",
          customType: HOST_SESSION_CUSTOM_TYPE,
          data: { action: "set", key: "codex", sessionId: "host-sid-1" },
        },
      ]);
      expect(port.flushCount).toBe(1);
    });

    it("pre-send abort는 pending mapping을 durable append하지 않는다", async () => {
      const port = createSessionPort("pi-session-abort");
      const client = createMockClient("host-sid-abort");
      const controller = new AbortController();
      onHostSessionChange("pi-session-abort", port);
      vi.mocked(UnifiedAgent.build).mockResolvedValue(client);

      const handle = await ensure({
        cli: "codex" as any,
        backendModel: "gpt-test",
        scopeKey: "pre-send-abort",
        cwd: "/tmp",
      });
      controller.abort();

      await sendMessage(handle, { userRequest: "hello" }, controller.signal);

      expect(client.sendCount).toBe(0);
      expect(port.entries).toEqual([]);
      expect(port.flushCount).toBe(0);
    });

    it("resume mapping은 connect 시 duplicate durable set을 append하지 않는다", async () => {
      const port = createSessionPort("pi-session-resume", [
        {
          type: "custom",
          customType: HOST_SESSION_CUSTOM_TYPE,
          data: { action: "set", key: "codex", sessionId: "saved-host-sid" },
        },
      ]);
      const client = createMockClient("saved-host-sid");
      onHostSessionChange("pi-session-resume", port);
      vi.mocked(UnifiedAgent.build).mockResolvedValue(client);

      const handle = await ensure({
        cli: "codex" as any,
        backendModel: "gpt-test",
        scopeKey: "resume-ensure",
        cwd: "/tmp",
      });

      expect(handle.sessionId).toBe("saved-host-sid");
      expect(client.connectCalls[0]?.sessionId).toBe("saved-host-sid");
      expect(port.entries).toHaveLength(1);
    });

    it("connect completion 전에 host port가 바뀌면 pending host map을 오염시키지 않는다", async () => {
      const originPort = createSessionPort("pi-connect-origin");
      const nextPort = createSessionPort("pi-connect-next");
      let releaseConnect!: () => void;
      const connectStarted = new Promise<void>((resolve) => {
        const client = createMockClient("host-sid-connect-origin", {
          connectImpl: async () => {
            resolve();
            await new Promise<void>((release) => {
              releaseConnect = release;
            });
          },
        });
        vi.mocked(UnifiedAgent.build).mockResolvedValue(client);
      });
      onHostSessionChange("pi-connect-origin", originPort);

      const pendingEnsure = ensure({
        cli: "codex" as any,
        backendModel: "gpt-test",
        scopeKey: "connect-race",
        cwd: "/tmp",
      });
      await connectStarted;

      onHostSessionChange("pi-connect-next", nextPort);
      releaseConnect();
      const handle = await pendingEnsure;

      expect(handle.sessionId).toBe("host-sid-connect-origin");
      expect(originPort.entries).toEqual([]);
      expect(nextPort.entries).toEqual([]);
      expect(getHostSessionStore().get("codex")).toBeUndefined();
    });

    it("send settle 전에 host port가 바뀌면 origin mapping commit을 폐기하고 새 port를 오염시키지 않는다", async () => {
      const originPort = createSessionPort("pi-session-origin");
      const nextPort = createSessionPort("pi-session-next");
      let releaseSend!: () => void;
      const sendStarted = new Promise<void>((resolve) => {
        const client = createMockClient("host-sid-origin", {
          sendImpl: async () => {
            resolve();
            await new Promise<void>((release) => {
              releaseSend = release;
            });
          },
        });
        vi.mocked(UnifiedAgent.build).mockResolvedValue(client);
      });
      onHostSessionChange("pi-session-origin", originPort);

      const handle = await ensure({
        cli: "codex" as any,
        backendModel: "gpt-test",
        scopeKey: "port-race",
        cwd: "/tmp",
      });
      const pendingSend = sendMessage(handle, { userRequest: "hello" });
      await sendStarted;

      onHostSessionChange("pi-session-next", nextPort);
      releaseSend();
      await pendingSend;

      expect(originPort.entries).toEqual([]);
      expect(nextPort.entries).toEqual([]);
      expect(originPort.flushCount).toBe(0);
      expect(nextPort.flushCount).toBe(0);
    });
  });
});
