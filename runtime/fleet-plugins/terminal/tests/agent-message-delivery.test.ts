import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatPtyMessage, MAX_LAUNCH_PROMPT_CHARS } from "@dotobokuri/fleet-admiral";
import type { OperationCreateInput, OperationNode, OperationPatchInput } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAgentRoutes } from "../server/agent.js";
import type { TerminalRuntime } from "../server/shared/index.js";
import { createPluginTerminalTicketRegistry } from "../server/shared/tickets.js";

type TestRequest = http.IncomingMessage & { __body?: Record<string, unknown> };

const cleanups: Array<() => void | Promise<void>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// 라우트가 실제로 PTY에 쓰는 바이트는 formatPtyMessage 계약 그대로여야 한다 — 기대값을 같은
// 함수로 만들어 정책 기본값(bracketed paste·줄 종결자)이 바뀌어도 테스트가 따라간다.
function expectedChunks(text: string): readonly string[] {
  return formatPtyMessage({}, text, process.platform, { submitDelayMs: 250 }).map((chunk) => chunk.data);
}

describe("agent message delivery", () => {
  it("writes the formatted prompt into a live session and reports delivered", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);

    await harness.postMessage(sessionId, { text: "run the suite" });

    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { delivered: true } });
    await vi.waitFor(() => {
      expect(harness.writes).toEqual(expectedChunks("run the suite"));
    });
    // 살아 있는 세션에는 재기동이 없어야 한다 — attach는 생성 1회로 끝.
    expect(harness.attach).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ text: 7 }, 400, "message_invalid"],
    [{ text: "a".repeat(MAX_LAUNCH_PROMPT_CHARS + 1) }, 400, "prompt_too_long"],
    [{ text: "\u0007\u0000" }, 400, "message_empty"],
  ] as const)("rejects an invalid body %# without touching the PTY", async (body, status, error) => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);

    await harness.postMessage(sessionId, body as Record<string, unknown>);

    expect(harness.responses.at(-1)).toEqual({ status, body: { error } });
    expect(harness.writes).toEqual([]);
  });

  it("rejects an unknown operation with 404", async () => {
    const harness = await createHarness();

    await harness.postMessage("missing-operation", { text: "hello" });

    expect(harness.responses.at(-1)).toEqual({ status: 404, body: { error: "session_not_found" } });
  });

  it("rejects a dormant operation without a provider session with 409", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();

    await harness.postMessage(sessionId, { text: "hello" });

    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "resume_unavailable" } });
    expect(harness.attach).toHaveBeenCalledTimes(1);
  });

  it("rejects delivery into a session awaiting terminal input with 409", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);
    // 작성 중 CLI가 권한 프롬프트로 전환한 경합 — 전달 직전 재검사가 줄 종결자의 무단 확정을 막는다.
    await harness.postAttention(sessionId);

    await harness.postMessage(sessionId, { text: "run the suite" });

    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "session_awaiting_input" } });
    expect(harness.writes).toEqual([]);
  });

  it("resumes a dormant operation then delivers in the same request", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.attachProviderSession(sessionId);

    await harness.postMessage(sessionId, { text: "resume and summarize" });

    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { delivered: true, resumed: true } });
    expect(harness.attach).toHaveBeenCalledTimes(2);
    expect(harness.attach).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId,
      resumeSessionId: "provider-session-1",
    }));
    // 재기동 전달은 부팅 여유폭의 빈 선두 청크가 앞선다.
    await vi.waitFor(() => {
      expect(harness.writes).toEqual(["", ...expectedChunks("resume and summarize")]);
    }, { timeout: 4000 });
  }, 10000);

  it("keeps the draft deliverable when the resume spawn fails", async () => {
    const harness = await createHarness({ resumeAttachError: new Error("spawn failed") });
    const sessionId = await harness.createSession();
    harness.attachProviderSession(sessionId);

    await harness.postMessage(sessionId, { text: "resume and summarize" });

    expect(harness.responses.at(-1)).toEqual({ status: 503, body: { error: "terminal_unavailable" } });
    // 실패한 재기동 뒤에 죽은 세션으로 쓰기가 쌓이면 다음 재기동으로 샌다 — 전달은 없어야 한다.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(harness.writes).toEqual([]);
  });
});

async function createHarness(options: { readonly resumeAttachError?: Error } = {}) {
  const fleetDataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-terminal-message-"));
  temporaryDirectories.push(fleetDataDir);
  const operations: OperationNode[] = [];
  const responses: Array<{ readonly status: number; readonly body: unknown }> = [];
  const writes: string[] = [];
  const lifecycleCleanups: Array<() => void | Promise<void>> = [];
  const liveSessions = new Set<string>();
  let route: RouteHandler | undefined;
  const tickets = createPluginTerminalTicketRegistry();
  const attach = vi.fn<TerminalRuntime["attach"]>(async () => {
    if (options.resumeAttachError && attach.mock.calls.length > 1) throw options.resumeAttachError;
  });
  const terminalRuntime: TerminalRuntime = {
    handleUpgrade: () => false,
    renegotiateSockets: () => {},
    issueTicket: (context) => tickets.issue(context),
    invalidateTicketsForSession: (sessionId) => tickets.invalidateForSession(sessionId),
    canAttach: () => true,
    attach,
    write: (_operationId, data) => {
      writes.push(data);
      return true;
    },
    terminate: () => true,
    getMessagePolicy: () => ({}),
    getRenameCommand: () => undefined,
    getSessionLastActivityAt: (operationId) => (liveSessions.has(operationId) ? 5 : null),
    resolveSessionIdentity: async () => null,
    onExit: () => () => {},
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
        subscribe: () => () => {},
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
        readJsonBody: async <T,>(req: http.IncomingMessage) => ((req as TestRequest).__body ?? { theaterId: "theater-1", cliId: "claude" }) as T,
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

  async function createSession(): Promise<string> {
    if (!route) throw new Error("Agent route was not registered");
    await route({
      req: { method: "POST", url: "/plugins/terminal/agent/sessions" } as http.IncomingMessage,
      res: {} as http.ServerResponse,
      pathname: "/plugins/terminal/agent/sessions",
    });
    const operation = operations[0];
    if (!operation) throw new Error(`Session create failed: ${JSON.stringify(responses.at(-1))}`);
    return operation.id;
  }

  async function postMessage(sessionId: string, body: Record<string, unknown>): Promise<void> {
    if (!route) throw new Error("Agent route was not registered");
    await route({
      req: { method: "POST", url: `/plugins/terminal/agent/sessions/${sessionId}/message`, __body: body } as TestRequest,
      res: {} as http.ServerResponse,
      pathname: `/plugins/terminal/agent/sessions/${sessionId}/message`,
    });
  }

  async function postAttention(sessionId: string): Promise<void> {
    if (!route) throw new Error("Agent route was not registered");
    await route({
      req: { method: "POST", url: `/plugins/terminal/agent/sessions/${sessionId}/attention`, __body: { reason: "permission" } } as unknown as TestRequest,
      res: {} as http.ServerResponse,
      pathname: `/plugins/terminal/agent/sessions/${sessionId}/attention`,
    });
  }

  return {
    attach,
    responses,
    writes,
    createSession,
    postMessage,
    postAttention,
    setLive: (sessionId: string) => { liveSessions.add(sessionId); },
    attachProviderSession: (sessionId: string) => {
      const operation = operations.find((candidate) => candidate.id === sessionId);
      if (!operation) throw new Error("Operation not found");
      operation.payload.session = {
        ...(operation.payload.session as Record<string, unknown> | undefined),
        harness: "claude-code",
        id: "provider-session-1",
        capturedAt: "2026-08-13T00:00:00.000Z",
      };
    },
  };
}
