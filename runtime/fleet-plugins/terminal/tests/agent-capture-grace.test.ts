import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const harness = await createHarness({ cliId: "claude-gateway" });
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
    const harness = await createHarness({ cliId: "claude-gateway" });
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
    const harness = await createHarness({ cliId: "claude-gateway" });
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

  it("settles the turn-end background report inside the same turn transition", async () => {
    // Stop이 실어 온 두 사실(턴 종료·남은 백그라운드 작업)이 따로 반영되면 그 사이 프레임에서 세션이
    // 거짓 유휴로 읽혀 종료 알림과 도착 표시가 튄다. 한 번의 turn POST가 둘을 함께 확정해야 한다.
    const harness = await createHarness({
      cliId: "claude-gateway",
      phase: "end",
      input: JSON.stringify({ hook_event_name: "Stop", background_tasks: [{ id: "wf-1", type: "workflow", status: "running" }] }),
    });
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;

    await harness.turnSession(sessionId);

    expect((await harness.getSessions())[0]).toMatchObject({ sessionId, turnState: "ended", backgroundPending: true });
  });

  it("projects live tasks, holds through an unreadable report, and releases on an empty one", async () => {
    const body: Record<string, unknown> = {
      cliId: "claude-gateway",
      input: JSON.stringify({ hook_event_name: "SubagentStop", agent_id: "agent-1", background_tasks: [{ id: "wf-1", type: "workflow", status: "running" }] }),
    };
    const harness = await createHarness(body);
    await harness.postSessions();
    const sessionId = harness.operations[0]!.id;

    await harness.backgroundSession(sessionId);
    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { ok: true } });
    expect((await harness.getSessions())[0]).toMatchObject({ sessionId, backgroundPending: true });

    // 읽어내지 못한 보고는 무의견이다 — 이미 켜진 배지를 끄지 않아야 무의견과 해제가 구분된다.
    body.input = "not json";
    await harness.backgroundSession(sessionId);
    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { ok: true } });
    expect((await harness.getSessions())[0]).toMatchObject({ sessionId, backgroundPending: true });

    body.input = JSON.stringify({ hook_event_name: "Stop", background_tasks: [] });
    await harness.backgroundSession(sessionId);
    expect((await harness.getSessions())[0]).not.toHaveProperty("backgroundPending");
  });

  it("returns only invalid_agent_cli when a removed provider Operation is resumed", async () => {
    const harness = await createHarness({ cliId: "claude-gateway" });
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

  it("preserves legacy Codex transcript metadata when a restored Operation is renamed", async () => {
    const harness = await createHarness({ cliId: "claude-gateway" });
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

describe("agent session goal snapshot", () => {
  // 목표는 SSE 브로드캐스트에만 실려서는 안 된다. 새로 연 페이지와 재연결한 클라이언트는
  // GET 스냅샷만 받으므로, 여기서 빠지면 영수증이 영영 나타나지 않는다(헤디드 QA가 잡은 결함).
  it("includes the derived goal in the sessions snapshot, not only in the update broadcast", async () => {
    const harness = await createHarness({ cliId: "claude" });
    await harness.postSessions();
    const operation = harness.operations[0]!;

    const transcriptDirectory = mkdtempSync(path.join(os.tmpdir(), "fleet-goal-snapshot-"));
    temporaryDirectories.push(transcriptDirectory);
    const transcriptPath = path.join(transcriptDirectory, "transcript.jsonl");
    writeFileSync(transcriptPath, `${JSON.stringify({
      type: "attachment",
      attachment: { type: "goal_status", met: false, sentinel: true, condition: "ship it" },
    })}\n`);

    operation.payload.providerSession = { provider: "claude", sessionId: "provider-1", transcriptPath, capturedAt: "2026-08-07T00:00:00.000Z" };
    operation.payload.goal = { origin: "fleet", checkLimit: 8, requestedAt: 1, markerBaseline: 0, condition: "ship it" };

    const sessions = await harness.getSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.goal).toMatchObject({ origin: "fleet", condition: "ship it", checkLimit: 8 });
  });

  // 목표는 트랜스크립트에서 매번 파생되고 sentinel 마커는 지워지지 않는다 — 기록만 지우면
  // 바로 다음 파생이 같은 마커를 터미널 소유 목표로 되살려, 해제 버튼이 아무 일도 못 한다.
  it("does not resurrect a dismissed goal from the markers already in the transcript", async () => {
    const harness = await createHarness({ cliId: "claude" });
    await harness.postSessions();
    const operation = harness.operations[0]!;
    const sessionId = operation.id;
    operation.payload.providerSession = {
      provider: "claude",
      sessionId: "provider-1",
      transcriptPath: writeGoalTranscript([
        { type: "attachment", attachment: { type: "goal_status", met: false, sentinel: true, condition: "ship it" } },
        { type: "attachment", attachment: { type: "goal_status", met: true, condition: "ship it", iterations: 1 } },
      ]),
      capturedAt: "2026-08-07T00:00:00.000Z",
    };
    operation.payload.goal = { origin: "fleet", checkLimit: 8, requestedAt: 1, markerBaseline: 0, condition: "ship it" };
    expect((await harness.getSessions())[0]).toHaveProperty("goal");

    await harness.clearGoal(sessionId);

    expect(harness.operations[0]!.payload.goal).toBeUndefined();
    expect(harness.operations[0]!.payload.goalClearedBaseline).toBe(2);
    expect((await harness.getSessions())[0]).not.toHaveProperty("goal");
  });

  // Start fresh는 조건문을 다시 주입하지 않는다 — 새 프로세스가 강제하지 않는 목표를
  // 남겨 두면 영수증이 "요청됨"이라고 거짓말한다. 기준선도 사라진 트랜스크립트의 수다.
  it("drops a goal a fresh launch will not enforce", async () => {
    const harness = await createHarness({ cliId: "claude", fresh: true });
    await harness.postSessions();
    const operation = harness.operations[0]!;
    harness.markProviderSession(operation.id);
    operation.payload.goal = { origin: "fleet", checkLimit: 8, requestedAt: 1, markerBaseline: 3, condition: "ship it" };
    operation.payload.goalClearedBaseline = 1;

    await harness.resumeSession(operation.id);

    expect(harness.operations[0]!.payload.goal).toBeUndefined();
    expect(harness.operations[0]!.payload.goalClearedBaseline).toBeUndefined();
  });
});

function writeGoalTranscript(lines: readonly Record<string, unknown>[]): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fleet-goal-route-"));
  temporaryDirectories.push(directory);
  const transcriptPath = path.join(directory, "transcript.jsonl");
  writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return transcriptPath;
}

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
    issueTicket: () => ({ ticket: "ticket", ttlMs: 1_000 }),
    invalidateTicketsForSession: () => {},
    canAttach: () => true,
    attach,
    write,
    terminate,
    getMessagePolicy: () => ({}),
    getRenameCommand: () => undefined,
    getGoalCommand: () => undefined,
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
      operation.payload.providerSession = {
        provider: "claude",
        sessionId: "provider-session-1",
        capturedAt: "2026-07-25T00:00:00.000Z",
      };
    },
    clearGoal: async (sessionId: string) => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "DELETE", url: `/plugins/terminal/agent/sessions/${sessionId}/goal` } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: `/plugins/terminal/agent/sessions/${sessionId}/goal`,
      });
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
