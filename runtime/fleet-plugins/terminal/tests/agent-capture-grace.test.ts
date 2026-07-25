import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import type { OperationCreateInput, OperationNode, OperationPatchInput } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentSession } from "../client/agent/api.js";
import { registerAgentRoutes } from "../server/agent.js";
import { writeProviderSessionCaptureRaw } from "../server/agent-api/session-capture.js";
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
  it("keeps the provider capture until the deferred deletion is purged", async () => {
    const harness = createHarness({ initialPrompt: "hello" });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;
    harness.markProviderSession(sessionId);
    const capturePath = path.join(harness.fleetDataDir, `${sessionId}.json`);
    writeProviderSessionCaptureRaw(sessionId, JSON.stringify({ provider: "claude" }), { capturesDir: harness.fleetDataDir });
    expect(fs.existsSync(capturePath)).toBe(true);

    await harness.deleteSession(sessionId);

    // 삭제는 유예되므로 undo가 복원할 transcript가 남아 있어야 한다.
    expect(fs.existsSync(capturePath)).toBe(true);

    harness.emitHostEvent("operation:purged", { operationId: sessionId, pluginId: "terminal", type: "agent" });
    expect(fs.existsSync(capturePath)).toBe(false);
  });

  it("cancels pending OSC activity when a session is removed", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ cliId: "codex" });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;
    harness.emitTitle(sessionId, "⠏ theater");
    harness.emitTitle(sessionId, "theater");

    await harness.deleteSession(sessionId);
    vi.advanceTimersByTime(400);

    expect(await harness.getSessions()).toEqual([]);
  });

  it("cancels pending OSC activity before a PTY exit makes the session dormant", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ cliId: "codex" });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;
    harness.markProviderSession(sessionId);
    harness.emitTitle(sessionId, "⠏ theater");
    harness.emitTitle(sessionId, "theater");

    await harness.emitExit(sessionId);
    vi.advanceTimersByTime(400);

    expect(await harness.getSessions()).toEqual([
      expect.objectContaining({ sessionId, status: "dormant" }),
    ]);
    expect((await harness.getSessions())[0]).not.toHaveProperty("modelActivity");
  });

  it("cancels pending OSC activity before resume spawns a replacement PTY", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ cliId: "codex" });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;
    harness.markProviderSession(sessionId);
    harness.emitTitle(sessionId, "⠏ theater");
    harness.emitTitle(sessionId, "theater");

    await harness.resumeSession(sessionId);
    vi.advanceTimersByTime(400);

    expect((await harness.getSessions())[0]).toMatchObject({ sessionId, status: "terminal-only" });
    expect((await harness.getSessions())[0]).not.toHaveProperty("modelActivity");
  });

  it("resets tracker state on a turn transition before recommitting the same Codex bare title", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ cliId: "codex", phase: "start" });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;
    harness.emitTitle(sessionId, "⠏ theater");
    harness.emitTitle(sessionId, "theater");
    vi.advanceTimersByTime(400);
    expect((await harness.getSessions())[0]).toMatchObject({ modelActivity: "not-working" });

    await harness.turnSession(sessionId);
    expect((await harness.getSessions())[0]).toMatchObject({ turnState: "running" });
    expect((await harness.getSessions())[0]).not.toHaveProperty("modelActivity");

    harness.emitTitle(sessionId, "theater");
    vi.advanceTimersByTime(400);
    expect((await harness.getSessions())[0]).not.toHaveProperty("modelActivity");

    harness.emitTitle(sessionId, "⠏ theater");
    harness.emitTitle(sessionId, "theater");
    vi.advanceTimersByTime(400);
    expect((await harness.getSessions())[0]).toMatchObject({ modelActivity: "not-working" });
  });
});

function createHarness(body: Record<string, unknown>) {
  const fleetDataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-terminal-initial-prompt-"));
  temporaryDirectories.push(fleetDataDir);
  const operations: OperationNode[] = [];
  const eventListeners = new Map<string, Array<(payload: unknown) => void>>();
  const responses: Array<{ readonly status: number; readonly body: unknown }> = [];
  let route: RouteHandler | undefined;
  let lifecycleCleanup: (() => void | Promise<void>) | undefined;
  let exitCallback: ((operationId: string) => void | Promise<void>) | undefined;
  let titleCallback: ((operationId: string, title: string) => unknown) | undefined;
  const attach = vi.fn<TerminalRuntime["attach"]>(async () => {});
  const write = vi.fn<(sessionId: string, data: string) => boolean>(() => true);
  const terminate = vi.fn(() => true);
  const terminalRuntime: TerminalRuntime = {
    handleUpgrade: () => false,
    issueTicket: () => ({ ticket: "ticket", ttlMs: 1_000 }),
    canAttach: () => true,
    attach,
    write,
    terminate,
    getMessagePolicy: () => ({}),
    getRenameCommand: () => undefined,
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
      theaters: {
        registerRowBadgeProvider: () => () => {},
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
      paths: {
        fleetDataDir,
        capturesDir: fleetDataDir,
        pluginDataDir: () => fleetDataDir,
        resolveTheaterPath: (theaterId: string) => theaterId === "theater-1" ? path.join(fleetDataDir, "theater") : null,
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
          lifecycleCleanup = cleanup;
          return () => {};
        },
      },
    },
  } satisfies FleetPluginServerContext;

  const previousTerminalCommand = process.env.FLEET_TERMINAL_CMD;
  process.env.FLEET_TERMINAL_CMD = "test-terminal";
  registerAgentRoutes(ctx, terminalRuntime, { authService: {} as never, globalOptionsService: {} as never });
  cleanups.push(async () => {
    if (previousTerminalCommand === undefined) delete process.env.FLEET_TERMINAL_CMD;
    else process.env.FLEET_TERMINAL_CMD = previousTerminalCommand;
    await lifecycleCleanup?.();
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
      await route({
        req: { method: "POST", url: `/plugins/terminal/agent/sessions/${sessionId}/resume` } as http.IncomingMessage,
        res: {} as http.ServerResponse,
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
  };
}
