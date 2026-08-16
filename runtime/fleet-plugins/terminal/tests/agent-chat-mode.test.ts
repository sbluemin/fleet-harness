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
import { createPluginTerminalTicketRegistry } from "../server/shared/tickets.js";

type TestRequest = http.IncomingMessage & { __body?: Record<string, unknown> };

const cleanups: Array<() => void | Promise<void>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete (globalThis as { __fleetAgentChatSdkFactory?: unknown }).__fleetAgentChatSdkFactory;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("agent chat mode routes", () => {
  it("converts an idle live claude-gateway session: marks payload, invalidates tickets, terminates the pty", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);
    harness.attachProviderSession(sessionId);

    await harness.post(sessionId, "chat");

    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { ok: true } });
    expect(harness.operation(sessionId)?.payload.chatMode).toBe(true);
    expect(harness.terminate).toHaveBeenCalledWith(sessionId);
  });

  it("marks the session DTO as chat-adopted on conversion and releases it on DELETE", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);
    harness.attachProviderSession(sessionId);

    await harness.post(sessionId, "chat");

    // PTY 는 접혔지만 실행 표면은 살아 있다 — 이 사실이 DTO 에 실려야 사이드바가 휴면이라 말하지 않는다.
    // (이 하네스의 terminate 는 mock 이라 exit 콜백을 태우지 않으므로 status 의 dormant 전이는 여기서 증명되지
    //  않는다. 두 축이 함께 실린 뒤의 해석은 client/agent/connection 의 sessionRuntime 계약이 고정한다.)
    const adopted = (await harness.sessions()).find((session) => session.sessionId === sessionId);
    expect(adopted?.chatActive).toBe(true);

    await harness.del(sessionId, "chat");

    const released = (await harness.sessions()).find((session) => session.sessionId === sessionId);
    expect(released?.chatActive).toBeUndefined();
  });

  // 터미널로 열어 놓고 아직 아무것도 시키지 않은 세션. 트랜스크립트가 없는 것이 정상이고 잃을
  // 과거도 없다 — 여기서 거절하면 표면을 바꾸려는 사용자가 멀쩡한 터미널을 닫고 Operation을
  // 새로 만들어야 한다. 부재의 뜻을 가르는 것은 태생이 아니라 좌표가 심겼는지다.
  it("converts a terminal session that has not run its first turn yet", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);

    await harness.post(sessionId, "chat");

    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { ok: true } });
    expect(harness.operation(sessionId)?.payload.chatMode).toBe(true);
    expect(harness.terminate).toHaveBeenCalledWith(sessionId);
  });

  it("rejects conversion while the terminal turn is running", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);
    harness.attachProviderSession(sessionId);
    await harness.post(sessionId, "turn", { phase: "start" });

    await harness.post(sessionId, "chat");

    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "chat_convert_busy", reason: "turn" } });
    expect(harness.operation(sessionId)?.payload.chatMode).toBeUndefined();
    expect(harness.terminate).not.toHaveBeenCalled();
  });

  it("rejects conversion while background agent work is still pending", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);
    harness.attachProviderSession(sessionId);
    // 턴은 끝났지만 워크플로우 백그라운드 작업이 살아 있는 상태 — PTY를 접으면 그 작업이 죽는다.
    await harness.post(sessionId, "background", { input: JSON.stringify({ background_tasks: [{ id: "wf-1", type: "workflow" }] }) });

    await harness.post(sessionId, "chat");

    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "chat_convert_busy", reason: "background" } });
    expect(harness.terminate).not.toHaveBeenCalled();
  });

  it("rejects conversion while a pty launch is still pending", async () => {
    let releaseAttach: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseAttach = resolve; });
    const harness = await createHarness({ holdAttachAfterFirst: gate });
    const sessionId = await harness.createSession();
    harness.attachProviderSession(sessionId);
    // dormant 전달이 재기동을 시작해 attach가 in-flight인 'starting' 창을 연다.
    const delivery = harness.post(sessionId, "message", { text: "resume me" });
    await vi.waitFor(() => {
      expect(harness.attach).toHaveBeenCalledTimes(2);
    });

    await harness.post(sessionId, "chat");

    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "chat_convert_busy", reason: "starting" } });
    expect(harness.operation(sessionId)?.payload.chatMode).toBeUndefined();
    releaseAttach();
    await delivery;
  });

  // 터미널 복귀는 chat 마커를 먼저 걷고 resume을 부른다. 그래서 resume 시점에는 이 세션이 방금
  // 채팅에 있었다는 사실이 payload에 남지 않고, 남은 단서는 좌표가 없다는 것뿐이다 — 그것을
  // 거절하면 첫 턴 전에 표면을 바꾼 세션이 돌아올 길을 잃는다.
  it("resumes a session that never recorded a coordinate as a fresh start", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);
    await harness.post(sessionId, "chat");
    await harness.del(sessionId, "chat");

    await harness.post(sessionId, "resume");

    expect(harness.responses.at(-1)?.status).toBe(200);
  });

  // 좌표가 한 번 심긴 뒤의 부재는 "아직 시작 전"이 아니라 과거의 상실이다. fresh로 떨어뜨리면
  // 지워진 트랜스크립트가 조용히 무관한 새 세션으로 바뀌고, 그 세션이 이전 정체성을 덮어쓴다.
  it("rejects conversion when a captured transcript went missing", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);
    harness.attachProviderSession(sessionId);
    const payload = harness.operation(sessionId)?.payload as { providerSession?: Record<string, unknown> };
    payload.providerSession = { ...payload.providerSession, transcriptPath: "/tmp/fleet-chat-never-written/absent.jsonl" };

    await harness.post(sessionId, "chat");

    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "chat_transcript_missing" } });
  });

  it("rejects conversion for a session whose stored cli is not claude-gateway", async () => {
    // 신규 실행은 전부 claude-gateway로 정규화되지만, 저장된 payload가 다른 CLI를 말하는
    // Operation(외부 이식·구세대)은 chat이 받지 않는다.
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);
    harness.attachProviderSession(sessionId);
    harness.overrideCliId(sessionId, "codex");

    await harness.post(sessionId, "chat");

    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "chat_unsupported" } });
  });

  it("routes message delivery to the sdk turn instead of the pty while in chat mode", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.attachProviderSession(sessionId);
    await harness.post(sessionId, "chat");

    await harness.post(sessionId, "message", { text: "continue the refactor" });

    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { delivered: true, chat: true } });
    await vi.waitFor(() => {
      expect(harness.startTurn).toHaveBeenCalledWith(expect.objectContaining({
        prompt: "continue the refactor",
        resume: "sid-live",
        permissionMode: "bypassPermissions",
      }));
    });
    expect(harness.writes).toEqual([]);
    // 전달이 CLI 재기동을 유발하면 안 된다 — attach는 세션 생성 1회뿐이어야 한다.
    expect(harness.attach).toHaveBeenCalledTimes(1);
  });

  it("refuses a terminal ticket for a chat mode operation", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);
    harness.attachProviderSession(sessionId);
    await harness.post(sessionId, "chat");

    await harness.postTicket(sessionId);

    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "operation_chat_mode" } });
  });

  it("clears chat mode on DELETE so the terminal path reopens", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.attachProviderSession(sessionId);
    await harness.post(sessionId, "chat");
    expect(harness.operation(sessionId)?.payload.chatMode).toBe(true);

    await harness.del(sessionId, "chat");

    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { ok: true } });
    expect(harness.operation(sessionId)?.payload.chatMode).toBeUndefined();
  });

  it("resume on a chat mode operation clears the marker and relaunches the cli", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.attachProviderSession(sessionId);
    await harness.post(sessionId, "chat");

    await harness.post(sessionId, "resume");

    expect(harness.responses.at(-1)?.status).toBe(200);
    expect(harness.operation(sessionId)?.payload.chatMode).toBeUndefined();
    expect(harness.attach).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId,
      resumeSessionId: "sid-live",
    }));
  });

  it("streams the replayed journal over the chat stream", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.attachProviderSession(sessionId);
    await harness.post(sessionId, "chat");

    const frames = await harness.openChatStream(sessionId);

    const kinds = frames.map((frame) => frame.event.kind);
    expect(kinds[0]).toBe("replay-start");
    expect(kinds).toContain("dispatch");
    expect(kinds).toContain("replay-end");
  });

  // chatBorn 예외는 첫 좌표가 생기기 전까지만 산다. providerSession이 심린 뒤의 transcript 부재는
  // 채팅으로 태어난 Operation에서도 상실이므로, 표식만 보고 새 세션을 만들어 이전 정체성을
  // 덮어쓰면 안 된다.
  it("rejects a chat-born Operation whose established transcript disappeared", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.markChatBorn(sessionId);
    harness.attachProviderSession(sessionId);
    harness.removeTranscript();

    await harness.post(sessionId, "chat");

    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "chat_transcript_missing" } });
  });

  // 반대편 경계 — 아직 첫 턴을 돌지 않은(좌표가 없는) 채팅 출생은 그대로 통과해야 한다.
  it("still admits a chat-born Operation that has not produced a session yet", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.markChatBorn(sessionId);
    harness.removeTranscript();

    await harness.post(sessionId, "chat");

    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { ok: true } });
  });

  it("rejects the chat stream when the operation is not in chat mode", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.attachProviderSession(sessionId);

    await harness.get(sessionId, "chat-stream");

    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "chat_not_active" } });
  });
});

async function createHarness(options: { readonly cliId?: string; readonly holdAttachAfterFirst?: Promise<void> } = {}) {
  const cliId = options.cliId ?? "claude-gateway";
  const fleetDataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-terminal-chat-"));
  temporaryDirectories.push(fleetDataDir);
  // 원 세션 트랜스크립트 픽스처 — providerSession.transcriptPath가 가리킨다.
  const transcriptDir = path.join(fleetDataDir, "projects", "-tmp-workspace");
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, "sid-live.jsonl");
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user", message: { role: "user", content: "first order" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
  ].join("\n"));

  const sdkConfigDir = mkdtempSync(path.join(os.tmpdir(), "fleet-chat-sdk-"));
  temporaryDirectories.push(sdkConfigDir);
  const startTurn = vi.fn(async (_turn: unknown) => ({
    close: () => {},
    [Symbol.asyncIterator]() {
      const messages = [
        { type: "system", subtype: "init", session_id: "sid-live" },
        { type: "assistant", message: { content: [{ type: "text", text: "continuing" }] } },
        { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
      ];
      let index = 0;
      return {
        async next() {
          if (index >= messages.length) return { done: true as const, value: undefined };
          return { done: false as const, value: messages[index++] };
        },
      };
    },
  }));
  (globalThis as { __fleetAgentChatSdkFactory?: unknown }).__fleetAgentChatSdkFactory = async ({ models }: { readonly models: readonly string[] }) => ({
    configDir: sdkConfigDir,
    models,
    startTurn,
    dispose: async () => {},
  });

  const operations: OperationNode[] = [];
  const responses: Array<{ readonly status: number; readonly body: unknown }> = [];
  const writes: string[] = [];
  const lifecycleCleanups: Array<() => void | Promise<void>> = [];
  const liveSessions = new Set<string>();
  let route: RouteHandler | undefined;
  const tickets = createPluginTerminalTicketRegistry();
  const attach = vi.fn<TerminalRuntime["attach"]>(async () => {
    if (options.holdAttachAfterFirst && attach.mock.calls.length > 1) await options.holdAttachAfterFirst;
  });
  const terminate = vi.fn((sessionId: string) => {
    liveSessions.delete(sessionId);
    return true;
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
    terminate,
    getMessagePolicy: () => ({}),
    getRenameCommand: () => undefined,
    getSessionLastActivityAt: (operationId) => (liveSessions.has(operationId) ? 5 : null),
    resolveSessionIdentity: async () => null,
    onExit: () => () => {},
    onTitle: () => () => {},
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
      server: { origin: () => "http://127.0.0.1:4400" },
      paths: {
        fleetDataDir,
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
        readJsonBody: async <T,>(req: http.IncomingMessage) => ((req as TestRequest).__body ?? { theaterId: "theater-1", cliId }) as T,
      },
      security: {
        validateHost: () => true,
        isTerminalAuthorized: () => true,
        isLockAuthorized: () => true,
        resolveTerminalSocketRole: () => "control" as const,
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

  async function dispatch(method: string, sessionId: string, action: string, body?: Record<string, unknown>, res?: http.ServerResponse): Promise<void> {
    if (!route) throw new Error("Agent route was not registered");
    await route({
      req: { method, url: `/plugins/terminal/agent/sessions/${sessionId}/${action}`, ...(body ? { __body: body } : {}), on: () => {} } as unknown as TestRequest,
      res: res ?? ({} as http.ServerResponse),
      pathname: `/plugins/terminal/agent/sessions/${sessionId}/${action}`,
    });
  }

  return {
    attach,
    terminate,
    startTurn,
    responses,
    writes,
    operation: (id: string) => operations.find((operation) => operation.id === id),
    createSession: async (): Promise<string> => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "POST", url: "/plugins/terminal/agent/sessions" } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: "/plugins/terminal/agent/sessions",
      });
      const operation = operations[0];
      if (!operation) throw new Error(`Session create failed: ${JSON.stringify(responses.at(-1))}`);
      return operation.id;
    },
    sessions: async (): Promise<readonly Record<string, unknown>[]> => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "GET", url: "/plugins/terminal/agent/sessions" } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: "/plugins/terminal/agent/sessions",
      });
      const body = responses.at(-1)?.body as { readonly sessions?: readonly Record<string, unknown>[] } | undefined;
      return body?.sessions ?? [];
    },
    post: (sessionId: string, action: string, body?: Record<string, unknown>) => dispatch("POST", sessionId, action, body),
    del: (sessionId: string, action: string) => dispatch("DELETE", sessionId, action),
    get: (sessionId: string, action: string) => dispatch("GET", sessionId, action),
    postTicket: async (sessionId: string): Promise<void> => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "POST", url: "/plugins/terminal/agent/ticket", __body: { operationId: sessionId } } as unknown as TestRequest,
        res: {} as http.ServerResponse,
        pathname: "/plugins/terminal/agent/ticket",
      });
    },
    openChatStream: async (sessionId: string): Promise<Array<{ seq: number; event: { kind: string } }>> => {
      const chunks: string[] = [];
      const res = {
        writableEnded: false,
        destroyed: false,
        writeHead: () => res,
        write: (data: string) => {
          chunks.push(data);
          return true;
        },
        end: () => {},
      } as unknown as http.ServerResponse;
      await dispatch("GET", sessionId, "chat-stream", undefined, res);
      await vi.waitFor(() => {
        expect(chunks.join("")).toContain("replay-end");
      });
      return chunks
        .join("")
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice("data: ".length)) as { seq: number; event: { kind: string } });
    },
    setLive: (sessionId: string) => { liveSessions.add(sessionId); },
    overrideCliId: (sessionId: string, value: string) => {
      const operation = operations.find((candidate) => candidate.id === sessionId);
      if (!operation) throw new Error("Operation not found");
      operation.payload.cliId = value;
    },
    /** 채팅으로 태어난 Operation의 durable 표식을 세운다. */
    markChatBorn: (sessionId: string) => {
      const operation = operations.find((candidate) => candidate.id === sessionId);
      if (!operation) throw new Error("Operation not found");
      operation.payload.chatBorn = true;
    },
    /** 원 트랜스크립트를 밖에서 치운다 — 되쓰기 뒤 파일이 사라진 상태의 재현. */
    removeTranscript: () => {
      rmSync(transcriptDir, { recursive: true, force: true });
    },
    attachProviderSession: (sessionId: string) => {
      const operation = operations.find((candidate) => candidate.id === sessionId);
      if (!operation) throw new Error("Operation not found");
      operation.payload.providerSession = {
        provider: "claude",
        sessionId: "sid-live",
        transcriptPath,
        capturedAt: "2026-08-14T00:00:00.000Z",
      };
    },
  };
}
