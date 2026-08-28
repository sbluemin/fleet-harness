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

describe("agent launch variants", () => {
  it.each([
    [{ cliId: "claude", model: 5 }, 400, "invalid_launch_option"],
    [{ cliId: "claude", model: "cursor--missing" }, 409, "gateway_model_not_enabled"],
    // 네이티브 행의 ultra는 하네스 능력이라 허용된다 — 사다리 어휘 밖의 값만 거부한다.
    [{ cliId: "claude", model: "fable", effort: "minimal" }, 400, "invalid_effort"],
    [{ cliId: "claude", effort: "max" }, 400, "invalid_launch_option"],
  ] as const)("rejects invalid launch body %#", async (body, status, error) => {
    const harness = await createHarness({ body });

    await harness.postSessions();

    expect(harness.responses.at(-1)).toEqual({ status, body: { error } });
    expect(harness.attach).not.toHaveBeenCalled();
  });

  it("rejects effort outside a model's exposed ladder", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", model: "kimi--k3", effort: "high" },
      aiGatewaySettings: {
        version: 1,
        models: [{ id: "kimi--k3", efforts: ["max"] }],
      },
    });

    await harness.postSessions();

    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "invalid_effort" } });
    expect(harness.attach).not.toHaveBeenCalled();
  });

  it("accepts the ultra launch sentinel for any enabled gateway model", () => {
    // ultra는 카탈로그 사다리 밖의 하네스 능력이다 — MAX가 없는 모델과 강도를 아예 지원하지
    // 않는 모델에서도 사다리·노출 검증 없이 허용된다.
    const maxLess = resolveAiGatewaySelection({
      version: 1,
      models: [{ id: "cursor--grok-4.6-fast" }],
    });
    expect(isGatewayLaunchEffortAllowed(maxLess, maxLess.models[0]!, "ultra")).toBe(true);

    const noEffort = resolveAiGatewaySelection({
      version: 1,
      models: [{ id: "cursor--auto" }],
    });
    expect(isGatewayLaunchEffortAllowed(noEffort, noEffort.models[0]!, "ultra")).toBe(true);

    // 일상 단은 여전히 어휘와 모델 노출 검증을 받는다.
    expect(isGatewayLaunchEffortAllowed(maxLess, maxLess.models[0]!, "max")).toBe(false);
    expect(isGatewayLaunchEffortAllowed(noEffort, noEffort.models[0]!, "high")).toBe(false);
    expect(isGatewayLaunchEffortAllowed(maxLess, maxLess.models[0]!, "minimal")).toBe(false);
  });

  it("threads a valid scoped gateway model and effort into attach", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", model: "kimi--k3", effort: "max" },
      aiGatewaySettings: {
        version: 1,
        models: [{ id: "kimi--k3", efforts: ["max"] }],
      },
    });

    await harness.postSessions();

    expect(harness.responses.at(-1)?.status).toBe(200);
    expect(harness.attach).toHaveBeenCalledWith(expect.objectContaining({
      cliId: "claude",
      model: "kimi--k3",
      effort: "max",
    }));
  });

  it("removes the pending operation when the gateway model becomes stale during spawn", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", model: "fable", effort: "max" },
      attachError: new GatewayLaunchOptionError("gateway_model_not_enabled", "gateway_model_not_enabled"),
    });

    await harness.postSessions();

    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "gateway_model_not_enabled" } });
    expect(harness.operations).toEqual([]);
  });

  it("maps a spawn-time invalid effort and removes its pending operation", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", model: "fable", effort: "max" },
      attachError: new GatewayLaunchOptionError("invalid_effort", "invalid_effort"),
    });

    await harness.postSessions();

    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "invalid_effort" } });
    expect(harness.operations).toEqual([]);
  });

  it("retains the errored operation when terminal infrastructure fails", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", model: "fable", effort: "max" },
      attachError: new Error("pty unavailable"),
    });

    await harness.postSessions();

    expect(harness.responses.at(-1)).toEqual({ status: 503, body: { error: "terminal_unavailable" } });
    expect(harness.operations).toHaveLength(1);
  });

  it("persists the launch model and effort and reuses them for resume", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", model: "fable[1m]", effort: "max" },
    });

    await harness.postSessions();

    expect(harness.responses.at(-1)?.status).toBe(200);
    expect(harness.attach).toHaveBeenCalledWith(expect.objectContaining({
      cliId: "claude",
      model: "fable[1m]",
      effort: "max",
    }));
    expect(harness.operations[0]?.payload).toMatchObject({
      session: { harness: "claude-code", model: "fable[1m]", effort: "max" },
    });

    const sessionId = harness.operations[0]!.id;
    harness.operations[0]!.payload.session = {
      ...(harness.operations[0]!.payload.session as Record<string, unknown> | undefined),
      harness: "claude-code",
      id: "provider-session-1",
      capturedAt: "2026-08-07T00:00:00.000Z",
    };
    await harness.transitionToDormant(sessionId);
    await harness.resumeSession(sessionId);

    expect(harness.attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      model: "fable[1m]",
      effort: "max",
      resumeSessionId: "provider-session-1",
    }));
  });

  it("falls back to opus[1m] when a legacy Claude Gateway operation has no launch model", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", model: "sonnet", effort: "high" },
    });
    const sessionId = await harness.createLiveSession();
    await harness.transitionToDormant(sessionId);
    harness.operations[0]!.payload.session = {
      harness: "claude-code",
      id: "provider-session-1",
      capturedAt: "2026-07-25T00:00:00.000Z",
    };
    expect(harness.operations[0]?.payload.session).not.toHaveProperty("model");

    await harness.resumeSession(sessionId);

    expect(harness.attach).toHaveBeenCalledTimes(2);
    expect(harness.attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      cliId: "claude",
      model: "opus[1m]",
      resumeSessionId: "provider-session-1",
    }));
    expect(harness.attach.mock.calls[1]?.[0]).not.toHaveProperty("effort");
    expect(harness.operations[0]?.payload).toMatchObject({ session: { harness: "claude-code", model: "opus[1m]" } });
  });

  it("reuses the persisted launch model and effort when starting fresh", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", model: "sonnet", effort: "high" },
    });
    const sessionId = await harness.createLiveSession();
    await harness.transitionToDormant(sessionId);

    await harness.resumeSession(sessionId, { fresh: true });

    expect(harness.attach.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      model: "sonnet",
      effort: "high",
    }));
    expect(harness.attach.mock.calls[1]?.[0]).not.toHaveProperty("resumeSessionId");
    expect(harness.operations[0]?.payload.session).toMatchObject({
      harness: "claude-code",
      model: "sonnet",
      effort: "high",
    });
  });

  it("reports a persisted gateway model that is no longer enabled", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", model: "sonnet", effort: "high" },
      resumeAttachError: new GatewayLaunchOptionError("gateway_model_not_enabled", "gateway_model_not_enabled"),
    });
    const sessionId = await harness.createLiveSession();
    await harness.transitionToDormant(sessionId);

    await harness.resumeSession(sessionId);

    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "gateway_model_not_enabled" } });
    expect((await harness.getSessions())[0]).toMatchObject({ sessionId, status: "dormant" });
  });

  it.each([
    ["fable", "fable[1m]"],
    ["opus", "opus[1m]"],
  ])("rewrites bare %s onto Claude Code's 1M coordinate before attach", async (model, expected) => {
    const harness = await createHarness({
      body: { cliId: "claude", model, effort: "high" },
    });

    await harness.postSessions();

    expect(harness.responses.at(-1)?.status).toBe(200);
    expect(harness.attach).toHaveBeenCalledWith(expect.objectContaining({
      cliId: "claude",
      model: expected,
      effort: "high",
    }));
  });

  it("rejects a non-string prompt", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", prompt: 12 },
    });

    await harness.postSessions();

    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "invalid_prompt" } });
    expect(harness.attach).not.toHaveBeenCalled();
  });

  it("rejects a prompt longer than MAX_LAUNCH_PROMPT_CHARS", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", prompt: "x".repeat(MAX_LAUNCH_PROMPT_CHARS + 1) },
    });

    await harness.postSessions();

    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "prompt_too_long" } });
    expect(harness.attach).not.toHaveBeenCalled();
  });

  it("omits a whitespace-only prompt from attach", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", prompt: "   \n\t  " },
    });

    await harness.postSessions();

    expect(harness.responses.at(-1)?.status).toBe(200);
    expect(harness.attach).toHaveBeenCalledTimes(1);
    expect(harness.attach.mock.calls[0]?.[0]).not.toHaveProperty("prompt");
  });

  it("accepts prompt for claude-gateway and keeps it out of response and durable payload", async () => {
    const harness = await createHarness({
      body: { cliId: "claude", prompt: "launch me" },
    });

    await harness.postSessions();

    expect(harness.responses.at(-1)?.status).toBe(200);
    expect(harness.attach).toHaveBeenCalledWith(expect.objectContaining({
      cliId: "claude",
      prompt: "launch me",
    }));
    expect(containsKey(harness.responses.at(-1)?.body, "prompt")).toBe(false);
    expect(containsKey(harness.operations[0]?.payload, "prompt")).toBe(false);
  });
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

  it("rejects resume for an operation not owned by the terminal agent", async () => {
    const harness = await createHarness();
    harness.operations.push({
      id: "shell-operation",
      theaterId: "theater-1",
      type: "shell",
      pluginId: "terminal",
      title: "Shell",
      payload: {},
      geometry: null,
      ts: { createdAt: 1, updatedAt: 1 },
    });

    await harness.resumeSession("shell-operation");

    expect(harness.responses.at(-1)).toEqual({ status: 404, body: { error: "session_not_found" } });
    expect(harness.attach).not.toHaveBeenCalled();
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
