import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAiGatewaySelection, type AiGatewayStoredSettings } from "@dotobokuri/core-ai-gateway";
import { MAX_LAUNCH_PROMPT_CHARS } from "@dotobokuri/fleet-admiral";
import type { OperationCreateInput, OperationNode, OperationPatchInput } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayLaunchOptionError, isGatewayLaunchEffortAllowed } from "../server/agent-api/launch.js";
import { registerAgentRoutes } from "../server/agent.js";
import type { TerminalRuntime } from "../server/shared/index.js";
import { createPluginTerminalTicketRegistry } from "../server/shared/tickets.js";
import type { TerminalTicketContext } from "../server/shared/terminal-types.js";

const cleanups: Array<() => void | Promise<void>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("agent dormant ticket guards", () => {
  it("rejects ticket issuance for a dormant session with operation_dormant", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createLiveSession();
    await harness.transitionToDormant(sessionId);

    await harness.postTicket(sessionId);
    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "operation_dormant" } });
    expect(harness.ticketsIssued).toBe(0);
  });

  it("invalidates outstanding tickets when a session transitions to dormant", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createLiveSession();
    const issued = harness.issueDirectTicket(sessionId);
    expect(harness.tickets.consume(issued.ticket)).toMatchObject({ sessionId });

    const second = harness.issueDirectTicket(sessionId);
    await harness.transitionToDormant(sessionId);

    expect(harness.tickets.consume(second.ticket)).toBeNull();
    expect(harness.invalidateCalls).toEqual([sessionId]);
  });

  it("allows ticket issuance after resume moves the session out of dormant", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createLiveSession();
    await harness.transitionToDormant(sessionId);

    await harness.postTicket(sessionId);
    expect(harness.responses.at(-1)?.status).toBe(409);

    await harness.resumeSession(sessionId);
    expect(harness.attach).toHaveBeenCalledWith(expect.objectContaining({ sessionId }));
    const sessions = await harness.getSessions();
    expect(sessions[0]?.status).not.toBe("dormant");

    await harness.postTicket(sessionId);
    expect(harness.responses.at(-1)?.status).toBe(200);
    const body = harness.responses.at(-1)?.body as { readonly ticket?: string };
    expect(typeof body.ticket).toBe("string");
    expect(harness.tickets.consume(body.ticket!)).toMatchObject({ sessionId });
  });
});

type TestRequest = http.IncomingMessage & {
  readonly __body?: { readonly operationId?: string; readonly fresh?: boolean };
};

async function createHarness(options: {
  readonly body?: Readonly<Record<string, unknown>>;
  readonly aiGatewaySettings?: AiGatewayStoredSettings;
  readonly attachError?: Error;
  readonly resumeAttachError?: Error;
} = {}) {
  const fleetDataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-terminal-dormant-ticket-"));
  temporaryDirectories.push(fleetDataDir);
  const operations: OperationNode[] = [];
  const eventListeners = new Map<string, Array<(payload: unknown) => void>>();
  const responses: Array<{ readonly status: number; readonly body: unknown }> = [];
  const lifecycleCleanups: Array<() => void | Promise<void>> = [];
  const invalidateCalls: string[] = [];
  let route: RouteHandler | undefined;
  let exitCallback: ((operationId: string) => void | Promise<void>) | undefined;
  let ticketsIssued = 0;
  const tickets = createPluginTerminalTicketRegistry({
    randomTicket: (() => {
      let index = 0;
      return () => `ticket-${index++}`;
    })(),
  });
  const attach = vi.fn<TerminalRuntime["attach"]>(async () => {
    if (options.attachError) throw options.attachError;
    if (options.resumeAttachError && attach.mock.calls.length > 1) throw options.resumeAttachError;
  });
  const terminalRuntime: TerminalRuntime = {
    handleUpgrade: () => false,
    renegotiateSockets: () => {},
    issueTicket: (context) => {
      ticketsIssued += 1;
      return tickets.issue(context);
    },
    invalidateTicketsForSession: (sessionId) => {
      invalidateCalls.push(sessionId);
      tickets.invalidateForSession(sessionId);
    },
    canAttach: () => true,
    attach,
    write: () => true,
    terminate: () => true,
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
    onTitle: () => () => {},
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
            id: input.id ?? cryptoRandomId(),
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
          const index = operations.findIndex((candidate) => candidate.id === id);
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
        resolveTheaterPath: (theaterId: string) => theaterId === "theater-1" ? path.join(fleetDataDir, "theater") : null,
        canonicalizeTheaterPath: (cwd: string) => cwd,
        workspaceHash: () => "theater-1",
        ensureWorkspaceDirectory: (cwd: string) => ({ path: `/tmp/ws/${cwd.replace(/\W+/g, "-")}`, id: "ws" }),
        withDirectoryLock: <T,>(_lockDir: string, operation: () => T): T => operation(),
      },
      storage: {
        readJson: async () => null,
        writeJson: async () => {},
      },
      http: {
        writeJson: (_res: http.ServerResponse, status: number, responseBody: unknown) => { responses.push({ status, body: responseBody }); },
        readJsonBody: async <T,>(req: http.IncomingMessage) => {
          const url = req.url ?? "";
          if (url.includes("/ticket")) return { operationId: (req as TestRequest).__body?.operationId } as T;
          if (url.includes("/resume")) return ((req as TestRequest).__body ?? {}) as T;
          return { theaterId: "theater-1", cliId: "claude", ...options.body } as T;
        },
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
    ...(options.aiGatewaySettings
      ? { readAiGatewaySettings: () => options.aiGatewaySettings! }
      : {}),
  });
  cleanups.push(async () => {
    if (previousTerminalCommand === undefined) delete process.env.FLEET_TERMINAL_CMD;
    else process.env.FLEET_TERMINAL_CMD = previousTerminalCommand;
    for (const cleanup of [...lifecycleCleanups].reverse()) await cleanup();
  });

  async function createLiveSession(): Promise<string> {
    if (!route) throw new Error("Agent route was not registered");
    await route({
      req: { method: "POST", url: "/plugins/terminal/agent/sessions" } as http.IncomingMessage,
      res: {} as http.ServerResponse,
      pathname: "/plugins/terminal/agent/sessions",
    });
    const sessionId = operations[0]!.id;
    const operation = operations[0]!;
    operation.payload.session = {
      ...(operation.payload.session as Record<string, unknown> | undefined),
      harness: "claude-code",
      id: "provider-session-1",
      capturedAt: "2026-07-25T00:00:00.000Z",
    };
    return sessionId;
  }

  async function transitionToDormant(sessionId: string): Promise<void> {
    if (!exitCallback) throw new Error("Terminal exit callback was not registered");
    await exitCallback(sessionId);
    const sessions = await getSessions();
    expect(sessions[0]).toMatchObject({ sessionId, status: "dormant" });
  }

  async function postTicket(operationId: string): Promise<void> {
    if (!route) throw new Error("Agent route was not registered");
    const req = {
      method: "POST",
      url: "/plugins/terminal/agent/ticket",
      __body: { operationId },
    } as http.IncomingMessage & { __body: { operationId: string } };
    await route({
      req,
      res: {} as http.ServerResponse,
      pathname: "/plugins/terminal/agent/ticket",
    });
  }

  async function getSessions(): Promise<readonly Record<string, unknown>[]> {
    if (!route) throw new Error("Agent route was not registered");
    const responseCount = responses.length;
    await route({
      req: { method: "GET", url: "/plugins/terminal/agent/sessions" } as http.IncomingMessage,
      res: {} as http.ServerResponse,
      pathname: "/plugins/terminal/agent/sessions",
    });
    const body = responses[responseCount]?.body as { readonly sessions?: readonly Record<string, unknown>[] } | undefined;
    return body?.sessions ?? [];
  }

  async function resumeSession(sessionId: string, body?: { readonly fresh?: boolean }): Promise<void> {
    if (!route) throw new Error("Agent route was not registered");
    await route({
      req: { method: "POST", url: `/plugins/terminal/agent/sessions/${sessionId}/resume`, ...(body ? { __body: body } : {}) } as TestRequest,
      res: {} as http.ServerResponse,
      pathname: `/plugins/terminal/agent/sessions/${sessionId}/resume`,
    });
  }

  function issueDirectTicket(sessionId: string) {
    const context: TerminalTicketContext = {
      cwd: path.join(fleetDataDir, "theater"),
      sessionId,
      operationId: sessionId,
      operationType: "agent",
      pluginId: "terminal",
      theaterId: "theater-1",
      cliId: "claude",
    };
    return tickets.issue(context);
  }

  return {
    attach,
    operations,
    tickets,
    responses,
    invalidateCalls,
    get ticketsIssued() { return ticketsIssued; },
    createLiveSession,
    postSessions: async () => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "POST", url: "/plugins/terminal/agent/sessions" } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: "/plugins/terminal/agent/sessions",
      });
    },
    transitionToDormant,
    postTicket,
    getSessions,
    resumeSession,
    issueDirectTicket,
  };
}

function cryptoRandomId(): string {
  return `session-${Math.random().toString(16).slice(2)}`;
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value as Record<string, unknown>).some(([entryKey, entryValue]) => (
    entryKey === key || containsKey(entryValue, key)
  ));
}
