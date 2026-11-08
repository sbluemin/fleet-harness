import type { AgentOptionsService } from "@fleet-console/infra";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAiGatewaySelection, type AiGatewayStoredSettings } from "@fleet-console/ai-gateway";
import { MAX_LAUNCH_PROMPT_CHARS } from "@fleet-console/agent-runtime/fleet";
import { readObjectiveLaunch, withObjectiveLaunchPreset, type ObjectiveRecordCreateInput, type ObjectiveRecord, type ObjectiveRecordPatchInput } from "../../features/objectives/shared/records/types.js";
import { createConsoleControl } from "../../features/execution/host/console-control.js";
import type { ConsoleRuntimeContext } from "../../features/execution/host/context.js";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayLaunchOptionError, isGatewayLaunchEffortAllowed } from "../../features/execution/host/agent/launch.js";
import { registerAgentRoutes } from "../../features/execution/host/agent/routes.js";
import type { TerminalRuntime } from "../../features/execution/host/terminal/index.js";
import { createPluginTerminalTicketRegistry } from "../../features/execution/host/terminal/tickets.js";
import type { TerminalTicketContext } from "../../features/execution/host/terminal/terminal-types.js";

const cleanups: Array<() => void | Promise<void>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("agent dormant ticket guards", () => {
  it("launches an enabled host-only model by its advertised gateway id", async () => {
    const harness = await createHarness({ body: { theaterId: "theater-1", cliId: "claude", model: "claude-gateway--codex--gpt-6-luna", effort: "low" }, aiGatewaySettings: { version: 1, models: [{ id: "codex--gpt-6-luna", hostOnly: true }] as unknown as Array<{ id: string }> } });
    const createRecord = vi.spyOn(harness.records, "create").mockImplementationOnce(() => { throw new Error("objective_owner_unavailable"); });
    await expect(harness.postSessions()).rejects.toThrow("objective_owner_unavailable");
    expect(await harness.getSessions()).toEqual([]);
    expect(harness.objectiveRecords).toEqual([]);
    expect(harness.attach).not.toHaveBeenCalled();
    createRecord.mockRestore();
    await harness.createLiveSession();
    expect(harness.attach).not.toHaveBeenCalled();
    expect(harness.responses.at(-1)?.status).toBe(200);
    expect(JSON.stringify(harness.objectiveRecords[0]?.session)).toContain("gpt-6-luna");
  });

  it("creates a dormant terminal launch without a process and starts fresh on first send with its saved settings", async () => {
    const harness = await createHarness();
    const control = harness.control;
    const caller = { kind: "plugin" as const, pluginId: "objectives" };
    const id = (await control.request(caller, { kind: "launch", commodoreId: "owner-1", theaterId: "theater-1", dormant: true, viewMode: "terminal", title: "Commander", model: "opus[1m]", effort: "high", sessionName: "commander", disableSubagents: true })).objectiveId;
    expect(harness.attach).not.toHaveBeenCalled();
    expect(control.observe(id)).toMatchObject({ lifecycle: "live", activity: "idle", surface: "chat", supportedActions: ["send"] });
    const objectiveRecord = harness.objectiveRecords.find((op) => op.id === id)!;
    expect(readObjectiveLaunch(objectiveRecord)).toMatchObject({ sessionName: "commander", model: "opus[1m]", effort: "high", viewMode: "chat", started: false });
    expect(harness.objectiveRecords).toHaveLength(1);
    expect(harness.attach).not.toHaveBeenCalled();
    harness.patch(id, { ...(withObjectiveLaunchPreset(objectiveRecord, { model: "sonnet", effort: "low", viewMode: "chat" })) });
    expect(harness.objectiveRecords.find((op) => op.id === id)).toHaveProperty("chatBorn", true);
    expect(control.observe(id)?.surface).toBe("chat");
    expect(await control.request(caller, { kind: "send", objectiveId: id, text: "Begin" })).toMatchObject({ objectiveId: id });
    expect(harness.attach).not.toHaveBeenCalled();
  });

  it("resumes a dormant member with the host subagent policy instead of a stale session block", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createLiveSession();
    const objectiveRecord = harness.objectiveRecords.find((op) => op.id === sessionId)!;
    harness.patch(sessionId, {
      ...({
        ...objectiveRecord,
        subagentSpawn: "default",
        session: { ...(objectiveRecord.session as Record<string, unknown>), disableSubagents: true },
      }),
    });
    await expect(harness.resumeSession(sessionId)).resolves.toBeUndefined();
    expect(harness.attach).not.toHaveBeenCalled();
    expect(harness.objectiveRecords.find((op) => op.id === sessionId)?.subagentSpawn).toBe("default");
  });

  it("resumes a dormant member through Console control without a message", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createLiveSession();
    // 생산자 세대는 같은 프로세스가 사는 동안 그대로이고, 재개한 새 프로세스에서 바뀐다 — 플러그인은 이것으로 그 사이의 휴면을 안다.
    const caller = { kind: "plugin" as const, pluginId: "objectives" };
    await expect(harness.control.request(caller, { kind: "resume", objectiveId: sessionId })).rejects.toThrow("chat_resume_unsupported");
    expect(harness.attach).not.toHaveBeenCalled();
    expect(harness.control.observe(sessionId)?.surface).toBe("chat");
  });

  it("rejects ticket issuance for a dormant session with objectiveRecord_dormant", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createLiveSession();

    await harness.postTicket(sessionId);
    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "objectiveRecord_chat_mode" } });
    expect(harness.ticketsIssued).toBe(0);
  });

  it("invalidates outstanding tickets when a session transitions to dormant", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createLiveSession();
    const issued = harness.issueDirectTicket(sessionId);
    expect(harness.tickets.consume(issued.ticket)).toMatchObject({ sessionId });

    const second = harness.issueDirectTicket(sessionId);
    await harness.postTicket(sessionId);

    expect(harness.tickets.consume(second.ticket)).toMatchObject({ sessionId });
    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "objectiveRecord_chat_mode" } });
  });

  it("allows ticket issuance after resume moves the session out of dormant", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createLiveSession();

    await harness.postTicket(sessionId);
    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "objectiveRecord_chat_mode" } });
    expect(harness.attach).not.toHaveBeenCalled();
  });
});

type TestRequest = http.IncomingMessage & {
  readonly __body?: { readonly objectiveId?: string; readonly fresh?: boolean };
};

async function createHarness(options: {
  readonly body?: Readonly<Record<string, unknown>>;
  readonly aiGatewaySettings?: AiGatewayStoredSettings;
  readonly attachError?: Error;
  readonly resumeAttachError?: Error;
} = {}) {
  const fleetDataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-terminal-dormant-ticket-"));
  temporaryDirectories.push(fleetDataDir);
  const objectiveRecords: ObjectiveRecord[] = [];
  const eventListeners = new Map<string, Array<(payload: unknown) => void>>();
  const responses: Array<{ readonly status: number; readonly body: unknown }> = [];
  const lifecycleCleanups: Array<() => void | Promise<void>> = [];
  const invalidateCalls: string[] = [];
  let route: RouteHandler | undefined;
  const control = createConsoleControl({ directory: path.join(fleetDataDir, "console-control"), objectiveRecords: () => objectiveRecords, theaters: () => [{ id: "theater-1", name: "Theater" }], pluginAvailable: (id) => id === "objectives" });
  let exitCallback: ((objectiveId: string) => void | Promise<void>) | undefined;
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
    terminateAndWait: async () => true,
    awaitWriterExit: async () => true,
    getMessagePolicy: () => ({}),
    getRenameCommand: () => undefined,
    getSessionLastActivityAt: () => null,
    isLive: () => false,
    getForegroundProcess: () => null,
    getShellLineState: () => null,
    onCwd: () => () => undefined,
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
  const agentOptionsStub: AgentOptionsService = { load: () => ({}), update: (mutate) => mutate({}) };
  const ctx = {
    consoleControl: control,
    dataDir: fleetDataDir,
    agentOptions: agentOptionsStub,
    agentCliPlugin: { url: async () => "http://127.0.0.1:9/fleet-plugin-stub/fleet.zip", close: async () => {} },
    spawnAgentProcess: () => { throw new Error("unexpected agent CLI spawn"); },
    basePath: "/api/v1",
    wsBasePath: "/api/v1/terminal/ws",
    registerRouter: (_path: string, handler: RouteHandler) => { route = handler; },
    registerWsHandler: () => {},
    host: {
      admiralMcp: { connect: () => ({
        getEndpoint: async () => ({ servers: [] }), issueSessionToken: () => [],
        releaseSessionToken: () => {}, cleanup: () => {},
      }) },
      objectiveRecords: {
        list: () => objectiveRecords,
        get: (id: string) => objectiveRecords.find((objectiveRecord) => objectiveRecord.id === id) ?? null,
        create: (input: ObjectiveRecordCreateInput) => {
          const createdAt = input.createdAt ?? Date.now();
          const objectiveRecord: ObjectiveRecord = {...({ ...(input ?? {}) }),
id: input.id ?? cryptoRandomId(),
theaterId: input.theaterId,
title: input.title,
ts: { createdAt, updatedAt: createdAt }};
          objectiveRecords.push(objectiveRecord);
          return objectiveRecord;
        },
        patch: (id: string, input: ObjectiveRecordPatchInput) => {
          const index = objectiveRecords.findIndex((objectiveRecord) => objectiveRecord.id === id);
          const current = objectiveRecords[index];
          if (!current) return null;
          const patched = {
            ...(input.id === current.id ? input as typeof current : current),
            ...(input.title === undefined ? {} : { title: input.title }),
            ...input,
            ts: { ...current.ts, updatedAt: Date.now() },
          };
          objectiveRecords[index] = patched;
          return patched;
        },
        delete: (id: string) => {
          const index = objectiveRecords.findIndex((candidate) => candidate.id === id);
          if (index < 0) return false;
          objectiveRecords.splice(index, 1);
          return true;
        },
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
      server: { origin: () => "http://127.0.0.1:4400" },
      paths: {
        fleetDataDir,
        consoleDataDir: fleetDataDir,
        resolveObjectiveOwner: () => "owner-1",
        listCommodoreTheaters: () => [{ id: "theater-1", label: "Project" }],
        resolveCommodoreTheaterPath: (_commodoreId: string, theaterId: string) => theaterId === "theater-1" ? path.join(fleetDataDir, "theater") : null,
        canonicalizeTheaterPath: (cwd: string) => cwd,
        workspaceHash: () => "theater-1",
        ensureWorkspaceDirectory: (cwd: string) => ({ path: `/tmp/ws/${cwd.replace(/\W+/g, "-")}`, id: "ws" }),
        withDirectoryLock: <T,>(_lockDir: string, objectiveRecord: () => T): T => objectiveRecord(),
      },
      http: {
        writeJson: (_res: http.ServerResponse, status: number, responseBody: unknown) => { responses.push({ status, body: responseBody }); },
        readJsonBody: async <T,>(req: http.IncomingMessage) => {
          const url = req.url ?? "";
          if (url.includes("/ticket")) return { objectiveId: (req as TestRequest).__body?.objectiveId } as T;
          if (url.includes("/resume")) return ((req as TestRequest).__body ?? {}) as T;
          return { commodoreId: "owner-1", theaterId: "theater-1", cliId: "claude", ...options.body } as T;
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
      lifecycle: {
        registerCleanup: (cleanup: () => void | Promise<void>) => {
          lifecycleCleanups.push(cleanup);
          return () => {};
        },
      },
    },
  } satisfies ConsoleRuntimeContext;

  (globalThis as { __fleetAgentChatSdkFactory?: unknown }).__fleetAgentChatSdkFactory = async () => ({
    configDir: fleetDataDir,
    models: ["claude--sonnet"],
    openSession: () => ({
      send: async function* () { yield { type: "result", subtype: "success" }; },
      close: async () => {},
    }),
    dispose: async () => {},
  });
  const previousTerminalCommand = process.env.FLEET_TERMINAL_CMD;
  process.env.FLEET_TERMINAL_CMD = "test-terminal";
  await registerAgentRoutes(ctx, terminalRuntime, {
    agentOptionsService: agentOptionsStub,
    ...(options.aiGatewaySettings
      ? { readAiGatewaySettings: () => options.aiGatewaySettings! }
      : {}),
  });
  cleanups.push(async () => {
    if (previousTerminalCommand === undefined) delete process.env.FLEET_TERMINAL_CMD;
    else process.env.FLEET_TERMINAL_CMD = previousTerminalCommand;
    for (const cleanup of [...lifecycleCleanups].reverse()) await cleanup();
    control.dispose();
  });

  async function createLiveSession(): Promise<string> {
    if (!route) throw new Error("Agent route was not registered");
    await route({
      req: { method: "POST", url: "/api/v1/agent/sessions" } as http.IncomingMessage,
      res: {} as http.ServerResponse,
      pathname: "/api/v1/agent/sessions",
    });
    const sessionId = objectiveRecords[0]!.id;
    const objectiveRecord = objectiveRecords[0]!;
    objectiveRecord.session = {
      ...(objectiveRecord.session as Record<string, unknown> | undefined),
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

  async function postTicket(objectiveId: string): Promise<void> {
    if (!route) throw new Error("Agent route was not registered");
    const req = {
      method: "POST",
      url: "/api/v1/agent/ticket",
      __body: { objectiveId },
    } as http.IncomingMessage & { __body: { objectiveId: string } };
    await route({
      req,
      res: {} as http.ServerResponse,
      pathname: "/api/v1/agent/ticket",
    });
  }

  async function getSessions(): Promise<readonly Record<string, unknown>[]> {
    if (!route) throw new Error("Agent route was not registered");
    const responseCount = responses.length;
    await route({
      req: { method: "GET", url: "/api/v1/agent/sessions" } as http.IncomingMessage,
      res: {} as http.ServerResponse,
      pathname: "/api/v1/agent/sessions",
    });
    const body = responses[responseCount]?.body as { readonly sessions?: readonly Record<string, unknown>[] } | undefined;
    return body?.sessions ?? [];
  }

  async function resumeSession(sessionId: string, body?: { readonly fresh?: boolean }): Promise<void> {
    if (!route) throw new Error("Agent route was not registered");
    await route({
      req: { method: "POST", url: `/api/v1/agent/sessions/${sessionId}/resume`, ...(body ? { __body: body } : {}) } as TestRequest,
      res: {} as http.ServerResponse,
      pathname: `/api/v1/agent/sessions/${sessionId}/resume`,
    });
  }

  function issueDirectTicket(sessionId: string) {
    const context: TerminalTicketContext = {
      cwd: path.join(fleetDataDir, "theater"),
      sessionId,
      objectiveId: sessionId,
      objectiveRecordType: "agent",
      pluginId: null,
      theaterId: "theater-1",
      cliId: "claude",
    };
    return tickets.issue(context);
  }

  return {
    dataDir: fleetDataDir,
    attach,
    control,
    objectiveRecords,
    patch: ctx.host.objectiveRecords.patch,
    records: ctx.host.objectiveRecords,
    tickets,
    responses,
    invalidateCalls,
    get ticketsIssued() { return ticketsIssued; },
    createLiveSession,
    postSessions: async () => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "POST", url: "/api/v1/agent/sessions" } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: "/api/v1/agent/sessions",
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
