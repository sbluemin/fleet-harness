import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OperationCreateInput, OperationNode, OperationPatchInput } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAgentRoutes } from "../server/agent.js";
import type { TerminalRuntime } from "../server/shared/index.js";

const cleanups: Array<() => void | Promise<void>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("agent provider capture grace", () => {
  it("cancels pending OSC activity when a session is removed", async () => {
    vi.useFakeTimers();
    const harness = await createHarness({ cliId: "claude" });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;
    harness.emitTitle(sessionId, "⠏ theater");
    harness.emitTitle(sessionId, "✳ theater");

    await harness.deleteSession(sessionId);
    vi.advanceTimersByTime(400);

    expect(await harness.getSessions()).toEqual([]);
  });

  it("cancels pending OSC activity before a PTY exit makes the session dormant", async () => {
    vi.useFakeTimers();
    const harness = await createHarness({ cliId: "claude" });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;
    harness.markProviderSession(sessionId);
    harness.emitTitle(sessionId, "⠏ theater");
    harness.emitTitle(sessionId, "✳ theater");

    await harness.emitExit(sessionId);
    vi.advanceTimersByTime(400);

    expect(await harness.getSessions()).toEqual([
      expect.objectContaining({ sessionId, status: "dormant" }),
    ]);
    expect((await harness.getSessions())[0]).not.toHaveProperty("modelActivity");
  });

  it("settles the turn-end background report inside the same turn transition", async () => {
    // Stop이 실어 온 두 사실(턴 종료·남은 백그라운드 작업)이 따로 반영되면 그 사이 프레임에서 세션이
    // 거짓 유휴로 읽혀 종료 알림과 도착 표시가 튄다. 한 번의 turn POST가 둘을 함께 확정해야 한다.
    const harness = await createHarness({
      cliId: "claude",
      phase: "end",
      input: JSON.stringify({ hook_event_name: "Stop", background_tasks: [{ id: "wf-1", type: "workflow", status: "running" }] }),
    });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;

    await harness.turnSession(sessionId);

    expect((await harness.getSessions())[0]).toMatchObject({ sessionId, turnState: "ended", backgroundPending: true });
  });

});

async function createHarness(body: Record<string, unknown>) {
  const fleetDataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-terminal-initial-prompt-"));
  temporaryDirectories.push(fleetDataDir);
  const operations: OperationNode[] = [];
  const eventListeners = new Map<string, Array<(payload: unknown) => void>>();
  const responses: Array<{ readonly status: number; readonly body: unknown }> = [];
  let route: RouteHandler | undefined;
  const lifecycleCleanups: Array<() => void | Promise<void>> = [];
  let exitCallback: ((operationId: string) => void | Promise<void>) | undefined;
  let titleCallback: ((operationId: string, title: string) => unknown) | undefined;
  const attach = vi.fn<TerminalRuntime["attach"]>(async () => {});
  const write = vi.fn<(sessionId: string, data: string) => boolean>(() => true);
  const terminate = vi.fn(() => true);
  const terminalRuntime: TerminalRuntime = {
    handleUpgrade: () => false,
    issueTicket: () => ({ ticket: "ticket", ttlMs: 1_000, role: "control" as const }),
    renegotiateSockets: () => {},
    invalidateTicketsForSession: () => {},
    canAttach: () => true,
    attach,
    write,
    terminate,
    getMessagePolicy: () => ({}),
    getRenameCommand: () => undefined,
    getSessionLastActivityAt: () => null,
    resolveSessionIdentity: async () => null,
    onExit: (callback) => {
      exitCallback = callback;
      return () => {
        if (exitCallback === callback) exitCallback = undefined;
      };
    },
    onTitle: (_operationType, callback) => {
      titleCallback = callback;
      return () => {
        if (titleCallback === callback) titleCallback = undefined;
      };
    },
    registerLaunchResolver: () => () => {},
    bindChatAttach: () => () => {},
    stop: async () => {},
  };
  const ctx = {
    pluginId: "terminal",
    manifest: { id: "terminal" },
    basePath: "/plugins/terminal",
    wsBasePath: "/plugins/terminal/ws",
    registerRouter: (_path: string, handler: RouteHandler) => { route = handler; },
    registerWsHandler: () => {},
    host: {
      operations: {
        list: () => operations,
        get: (id: string) => operations.find((operation) => operation.id === id) ?? null,
        create: (input: OperationCreateInput) => {
          const createdAt = input.createdAt ?? Date.now();
          const operation: OperationNode = {
            id: input.id ?? `operation-${operations.length + 1}`,
            theaterId: input.theaterId,
            type: input.type,
            pluginId: input.pluginId,
            title: input.title,
            payload: { ...(input.payload ?? {}) },
            geometry: input.geometry ?? null,
            ts: { createdAt, updatedAt: createdAt },
          };
          operations.push(operation);
          return operation;
        },
        patch: (id: string, input: OperationPatchInput) => {
          const index = operations.findIndex((operation) => operation.id === id);
          const current = operations[index];
          if (!current) return null;
          const patched = {
            ...current,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.payload === undefined ? {} : { payload: { ...input.payload } }),
            ts: { ...current.ts, updatedAt: Date.now() },
          };
          operations[index] = patched;
          return patched;
        },
        delete: (id: string) => {
          const index = operations.findIndex((operation) => operation.id === id);
          if (index < 0) return false;
          operations.splice(index, 1);
          return true;
        },
        registerOperationType: () => () => {},
        registerPayloadSanitizer: () => () => {},
        registerLaunchCatalog: () => () => {},
      },
      events: {
        publish: () => {},
        subscribe: (channel: string, listener: (payload: unknown) => void) => {
          const listeners = eventListeners.get(channel) ?? [];
          listeners.push(listener);
          eventListeners.set(channel, listeners);
          return () => {};
        },
        registerSseChannel: () => () => {},
      },
      server: { origin: () => null },
      paths: {
        fleetDataDir,
        pluginDataDir: () => fleetDataDir,
        resolveTheaterPath: (theaterId: string) => theaterId === "theater-1" ? path.join(fleetDataDir, "✳ theater") : null,
        canonicalizeTheaterPath: (cwd: string) => cwd,
        workspaceHash: () => "theater-1",
        ensureWorkspaceDirectory: (cwd: string) => ({ path: `/tmp/ws/${cwd.replace(/\W+/g, "-")}`, id: "theater-1" }),
        withDirectoryLock: <T,>(_lockDir: string, operation: () => T): T => operation(),
      },
      storage: {
        readJson: async () => null,
        writeJson: async () => {},
      },
      http: {
        writeJson: (_res: http.ServerResponse, status: number, responseBody: unknown) => { responses.push({ status, body: responseBody }); },
        readJsonBody: async <T,>() => ({ theaterId: "theater-1", cliId: "claude", ...body }) as T,
        securityHeaders: (extra?: Readonly<Record<string, string>>) => ({ ...(extra ?? {}) }),
      },
      security: {
        validateHost: () => true,
        isTerminalAuthorized: () => true,
        isLockAuthorized: () => true,
        resolveTerminalSocketRole: () => "control" as const,
        isWriteAdmitted: () => true,
        expectedOrigin: () => "http://127.0.0.1:1",
      },
      theaterFlags: { register: () => () => undefined },
      lifecycle: {
        registerCleanup: (cleanup: () => void | Promise<void>) => {
          lifecycleCleanups.push(cleanup);
          return () => {};
        },
      },
    },
  } satisfies FleetPluginServerContext;

  const previousTerminalCommand = process.env.FLEET_TERMINAL_CMD;
  process.env.FLEET_TERMINAL_CMD = "test-terminal";
  await registerAgentRoutes(ctx, terminalRuntime, {
    globalOptionsService: {
      load: () => ({ version: 1, agentIdleDormantMinutes: null }),
      save: (data) => data,
      update: (mutate) => mutate({ version: 1 }),
    },
  });
  cleanups.push(async () => {
    if (previousTerminalCommand === undefined) delete process.env.FLEET_TERMINAL_CMD;
    else process.env.FLEET_TERMINAL_CMD = previousTerminalCommand;
    for (const cleanup of [...lifecycleCleanups].reverse()) await cleanup();
  });

  return {
    attach,
    fleetDataDir,
    operations,
    emitHostEvent: (channel: string, payload: unknown) => {
      for (const listener of eventListeners.get(channel) ?? []) listener(payload);
    },
    responses,
    emitTitle: (sessionId: string, title: string) => {
      if (!titleCallback) throw new Error("Terminal title callback was not registered");
      titleCallback(sessionId, title);
    },
    terminate,
    write,
    emitExit: async (sessionId: string) => {
      if (!exitCallback) throw new Error("Terminal exit callback was not registered");
      await exitCallback(sessionId);
    },
    markProviderSession: (sessionId: string) => {
      const operation = operations.find((candidate) => candidate.id === sessionId);
      if (!operation) throw new Error(`Operation not found: ${sessionId}`);
      operation.payload.session = {
        ...(operation.payload.session as Record<string, unknown> | undefined),
        harness: "claude-code",
        id: "provider-session-1",
        capturedAt: "2026-07-25T00:00:00.000Z",
      };
    },
    deleteSession: async (sessionId: string) => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "DELETE", url: `/plugins/terminal/agent/sessions/${sessionId}` } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: `/plugins/terminal/agent/sessions/${sessionId}`,
      });
    },
    getSessions: async (): Promise<readonly Record<string, unknown>[]> => {
      if (!route) throw new Error("Agent route was not registered");
      const responseCount = responses.length;
      await route({
        req: { method: "GET", url: "/plugins/terminal/agent/sessions" } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: "/plugins/terminal/agent/sessions",
      });
      const response = responses[responseCount];
      const body = response?.body as { readonly sessions?: readonly Record<string, unknown>[] } | undefined;
      return body?.sessions ?? [];
    },
    postSessions: async () => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "POST", url: "/plugins/terminal/agent/sessions" } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: "/plugins/terminal/agent/sessions",
      });
    },
    resumeSession: async (sessionId: string) => {
      if (!route) throw new Error("Agent route was not registered");
      let status = 200;
      const res = {
        writeHead: (nextStatus: number) => {
          status = nextStatus;
          return res;
        },
        end: (data?: string) => {
          responses.push({ status, body: data ? JSON.parse(data) as unknown : undefined });
          return res;
        },
      } as unknown as http.ServerResponse;
      await route({
        req: { method: "POST", url: `/plugins/terminal/agent/sessions/${sessionId}/resume` } as http.IncomingMessage,
        res,
        pathname: `/plugins/terminal/agent/sessions/${sessionId}/resume`,
      });
    },
    turnSession: async (sessionId: string) => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "POST", url: `/plugins/terminal/agent/sessions/${sessionId}/turn` } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: `/plugins/terminal/agent/sessions/${sessionId}/turn`,
      });
    },
    backgroundSession: async (sessionId: string) => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "POST", url: `/plugins/terminal/agent/sessions/${sessionId}/background` } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: `/plugins/terminal/agent/sessions/${sessionId}/background`,
      });
    },
  };
}
