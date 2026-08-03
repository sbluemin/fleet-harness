import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
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
    const harness = createHarness({ cliId: "claude" });
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
    const harness = createHarness({ cliId: "claude" });
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

  it("cancels pending OSC activity before resume spawns a replacement PTY", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ cliId: "claude" });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;
    harness.markProviderSession(sessionId);
    harness.emitTitle(sessionId, "⠏ theater");
    harness.emitTitle(sessionId, "✳ theater");

    await harness.resumeSession(sessionId);
    vi.advanceTimersByTime(400);

    expect((await harness.getSessions())[0]).toMatchObject({ sessionId, status: "terminal-only" });
    expect((await harness.getSessions())[0]).not.toHaveProperty("modelActivity");
  });

  it("accepts background hook events and projects the pending state", async () => {
    const harness = createHarness({ cliId: "claude", event: "spawn" });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;

    await harness.backgroundSession(sessionId);

    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { ok: true } });
    expect((await harness.getSessions())[0]).toMatchObject({ sessionId, backgroundPending: true });
  });

  it("rejects invalid background hook events", async () => {
    const harness = createHarness({ cliId: "claude", event: "invalid" });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;

    await harness.backgroundSession(sessionId);

    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "invalid_event" } });
  });

  it("returns only invalid_agent_cli when a removed provider Operation is resumed", async () => {
    const harness = createHarness({ cliId: "claude" });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;
    harness.operations[0]!.payload.cliId = "codex";
    harness.markProviderSession(sessionId);

    await harness.resumeSession(sessionId);

    expect(harness.responses).toEqual([
      { status: 200, body: expect.objectContaining({ sessionId }) },
      { status: 400, body: { error: "invalid_agent_cli" } },
    ]);
    expect(harness.attach).toHaveBeenCalledTimes(1);
  });

  it("preserves legacy Codex transcript metadata when a restored Operation is renamed", () => {
    const harness = createHarness({ cliId: "claude" });
    const providerSession = {
      provider: "codex",
      sessionId: "legacy-codex-session",
      transcriptPath: "/legacy/codex/transcript.jsonl",
      source: "legacy-capture",
      capturedAt: "2026-07-25T00:00:00.000Z",
    } as const;
    harness.operations.push({
      id: "legacy-codex-operation",
      theaterId: "theater-1",
      type: "agent",
      pluginId: "terminal",
      title: "Legacy Codex",
      payload: {
        cliId: "codex",
        cwd: path.join(harness.fleetDataDir, "✳ theater"),
        providerSession,
      },
      geometry: null,
      ts: { createdAt: 1, updatedAt: 1 },
    });

    harness.emitHostEvent("operation:restored", {
      operationId: "legacy-codex-operation",
      pluginId: "terminal",
      type: "agent",
    });
    harness.emitHostEvent("operation:renamed", {
      operationId: "legacy-codex-operation",
      pluginId: "terminal",
      type: "agent",
      title: "Renamed legacy Codex",
      previousTitle: "Legacy Codex",
    });

    expect(harness.operations[0]!.payload.providerSession).toEqual(providerSession);
  });
});

function createHarness(body: Record<string, unknown>) {
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
    issueTicket: () => ({ ticket: "ticket", ttlMs: 1_000 }),
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
      },
      storage: {
        readJson: async () => null,
        writeJson: async () => {},
      },
      http: {
        writeJson: (_res: http.ServerResponse, status: number, responseBody: unknown) => { responses.push({ status, body: responseBody }); },
        readJsonBody: async <T,>() => ({ theaterId: "theater-1", cliId: "claude", ...body }) as T,
      },
      security: {
        validateHost: () => true,
        isTerminalAuthorized: () => true,
        isLockAuthorized: () => true,
      },
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
  registerAgentRoutes(ctx, terminalRuntime, {
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
      operation.payload.providerSession = {
        provider: "claude",
        sessionId: "provider-session-1",
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
