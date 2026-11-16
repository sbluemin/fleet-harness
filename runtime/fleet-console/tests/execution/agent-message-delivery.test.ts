import type { AgentOptionsService } from "@fleet-console/infra";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_LAUNCH_PROMPT_CHARS } from "@fleet-console/agent-runtime/fleet";
import type { ObjectiveRecordCreateInput, ObjectiveRecord, ObjectiveRecordPatchInput } from "../../features/objectives/shared/records/types.js";
import type { ConsoleRuntimeContext } from "../../features/execution/host/context.js";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAgentRoutes } from "../../features/execution/host/agent/routes.js";
import { createConsoleControl } from "../../features/execution/host/console-control.js";
import type { TerminalRuntime } from "../../features/execution/host/terminal/index.js";

type TestRequest = http.IncomingMessage & { __body?: Record<string, unknown> };

const cleanups: Array<() => void | Promise<void>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("agent message delivery", () => {
  it.each([
    [{ text: 7 }, 400, "message_invalid"],
    [{ text: "a".repeat(MAX_LAUNCH_PROMPT_CHARS + 1) }, 400, "prompt_too_long"],
    [{ text: "\u0007\u0000" }, 400, "message_empty"],
  ] as const)("rejects an invalid body %#", async (body, status, error) => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();

    await harness.postMessage(sessionId, body as Record<string, unknown>);

    expect(harness.responses.at(-1)).toEqual({ status, body: { error } });
    expect(harness.attach).not.toHaveBeenCalled();
  });

  it("rejects an unknown objectiveRecord with 404", async () => {
    const harness = await createHarness();

    await harness.postMessage("missing-objectiveRecord", { text: "hello" });

    expect(harness.responses.at(-1)).toEqual({ status: 404, body: { error: "session_not_found" } });
  });

  it("delivers a dormant objective without a provider session as chat", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();

    await harness.postMessage(sessionId, { text: "hello" });

    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { delivered: true, chat: true } });
    expect(harness.attach).not.toHaveBeenCalled();
  });

  it("delivers a dormant launch session as chat without starting a PTY", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.attachProviderSession(sessionId);

    await harness.postMessage(sessionId, { text: "resume and summarize" });

    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { delivered: true, chat: true } });
    expect(harness.attach).not.toHaveBeenCalled();
  });
});

async function createHarness() {
  const fleetDataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-terminal-message-"));
  temporaryDirectories.push(fleetDataDir);
  const objectiveRecords: ObjectiveRecord[] = [];
  const responses: Array<{ readonly status: number; readonly body: unknown }> = [];
  const lifecycleCleanups: Array<() => void | Promise<void>> = [];
  let route: RouteHandler | undefined;
  const attach = vi.fn<TerminalRuntime["attach"]>(async () => {});
  const terminalRuntime: TerminalRuntime = {
    handleUpgrade: () => false,
    renegotiateSockets: () => {},
    issueTicket: () => ({ ticket: "ticket", ttlMs: 1_000, role: "control" as const }),
    invalidateTicketsForSession: () => {},
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
    onExit: () => () => {},
    onTitle: () => () => {},
    registerLaunchResolver: () => () => {},
    bindChatAttach: () => () => {},
    stop: async () => {},
  };
  const agentOptionsStub: AgentOptionsService = { load: () => ({}), update: (mutate) => mutate({}) };
  const control = createConsoleControl({ directory: path.join(fleetDataDir, "console-control"), objectiveRecords: () => objectiveRecords, theaters: () => [{ id: "theater-1", name: "Project" }], pluginAvailable: () => true });
  const ctx = {
    dataDir: fleetDataDir,
    consoleControl: control,
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
id: input.id ?? `objective-${objectiveRecords.length + 1}`,
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
        subscribe: () => () => {},
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
        readJsonBody: async <T,>(req: http.IncomingMessage) => ((req as TestRequest).__body ?? { commodoreId: "owner-1", theaterId: "theater-1", cliId: "claude" }) as T,
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

  const previousTerminalCommand = process.env.FLEET_TERMINAL_CMD;
  process.env.FLEET_TERMINAL_CMD = "test-terminal";
  (globalThis as { __fleetAgentChatSdkFactory?: unknown }).__fleetAgentChatSdkFactory = async () => ({
    configDir: fleetDataDir,
    models: ["claude--sonnet"],
    openSession: () => ({ send: async function* () {}, close: async () => {} }),
    dispose: async () => {},
  });
  await registerAgentRoutes(ctx, terminalRuntime, {
    agentOptionsService: agentOptionsStub,
  });
  cleanups.push(async () => {
    if (previousTerminalCommand === undefined) delete process.env.FLEET_TERMINAL_CMD;
    else process.env.FLEET_TERMINAL_CMD = previousTerminalCommand;
    for (const cleanup of [...lifecycleCleanups].reverse()) await cleanup();
  });

  async function createSession(): Promise<string> {
    return (await control.request({ kind: "plugin", pluginId: "fixture" }, { kind: "launch", commodoreId: "owner-1", theaterId: "theater-1", dormant: true })).objectiveId;
  }

  async function postMessage(sessionId: string, body: Record<string, unknown>): Promise<void> {
    if (!route) throw new Error("Agent route was not registered");
    await route({
      req: { method: "POST", url: `/api/v1/agent/sessions/${sessionId}/message`, __body: body } as TestRequest,
      res: {} as http.ServerResponse,
      pathname: `/api/v1/agent/sessions/${sessionId}/message`,
    });
  }

  return {
    attach,
    responses,
    createSession,
    postMessage,
    attachProviderSession: (sessionId: string) => {
      const objectiveRecord = objectiveRecords.find((candidate) => candidate.id === sessionId);
      if (!objectiveRecord) throw new Error("Objective not found");
      objectiveRecord.session = {
        ...(objectiveRecord.session as Record<string, unknown> | undefined),
        harness: "claude-code",
        id: "provider-session-1",
        capturedAt: "2026-08-13T00:00:00.000Z",
        source: "launch",
      };
    },
  };
}
