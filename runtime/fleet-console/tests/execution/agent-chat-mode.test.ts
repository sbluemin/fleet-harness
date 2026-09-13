import http from "node:http";
import { mkdirSync, mkdtempSync, promises as fs, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OperationCreateInput, OperationNode, OperationPatchInput } from "@fleet-console/sdk/operations";
import type { ConsoleRuntimeContext } from "../../core/host/runtime-context.js";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAgentRoutes } from "../../core/host/agent/routes.js";
import { createConsoleControl } from "../../core/host/mcp/console-control.js";
import { resolveAgentCliBinary } from "../../core/host/agent/agent-cli-paths.js";
import type { TerminalRuntime, TerminalSocket } from "../../core/host/terminal/index.js";
import { createPluginTerminalTicketRegistry } from "../../core/host/terminal/tickets.js";

function createTestChatSocket(onSend: (raw: string) => void): TerminalSocket {
  const closeListeners = new Set<() => void>();
  return {
    readyState: 1,
    send(data: Buffer) {
      onSend(data.toString("utf8"));
    },
    close() {
      for (const listener of closeListeners) listener();
    },
    on() {},
    once(event, listener) {
      if (event === "close") closeListeners.add(listener);
    },
  };
}

type TestRequest = http.IncomingMessage & { __body?: Record<string, unknown> };

const cleanups: Array<() => void | Promise<void>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete (globalThis as { __fleetAgentChatSdkFactory?: unknown }).__fleetAgentChatSdkFactory;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("agent chat mode routes", () => {
  it("tracks Terminal requests to matching hook turns, projects public output, and confirms interruption", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);
    harness.allowConsoleUse(sessionId);
    harness.attachProviderSession(sessionId);
    const receipt = harness.consoleControl.request({ kind: "operation", operationId: sessionId }, "terminal-send", { kind: "send", operationId: sessionId, text: "Check terminal output" });
    await vi.waitFor(() => expect(harness.consoleControl.getAction(receipt.id)?.status).toBe("running"));
    await harness.post(sessionId, "turn", { phase: "start", input: JSON.stringify({ prompt: "Check terminal output" }) });
    await harness.post(sessionId, "turn", { phase: "end", input: JSON.stringify({ last_assistant_message: "Public result /private/example/output.txt sk-123456789012345678901234" }) });
    await vi.waitFor(() => expect(harness.consoleControl.getAction(receipt.id)).toMatchObject({ status: "finished", outcome: "completed" }));
    const output = harness.consoleControl.observe(sessionId)?.output;
    expect(output).toMatchObject({ status: "available", outcome: "completed", source: "terminal_hook" });
    expect(output?.text).toContain("Public result");
    expect(output?.text).not.toContain("/private/example");
    expect(output?.text).not.toContain("sk-123456789012345678901234");
    expect(harness.consoleControl.observe(sessionId)?.supportedActions).not.toContain("interrupt");
    const actionsBeforeIdleInterrupt = harness.consoleControl.state().actions.length;
    expect(() => harness.consoleControl.request({ kind: "operation", operationId: sessionId }, "idle-interrupt", { kind: "interrupt", operationId: sessionId })).toThrow("nothing_to_interrupt");
    expect(harness.consoleControl.state().actions).toHaveLength(actionsBeforeIdleInterrupt);
    expect(harness.writes).not.toContain("");
    const next = harness.consoleControl.request({ kind: "operation", operationId: sessionId }, "terminal-next", { kind: "send", operationId: sessionId, text: "Wait for interruption" });
    await vi.waitFor(() => expect(harness.consoleControl.getAction(next.id)?.status).toBe("running"));
    await harness.post(sessionId, "turn", { phase: "start", input: JSON.stringify({ prompt: "Wait for interruption" }) });
    const interrupt = harness.consoleControl.request({ kind: "operation", operationId: sessionId }, "terminal-interrupt", { kind: "interrupt", operationId: sessionId });
    await vi.waitFor(() => expect(harness.writes).toContain(""));
    expect(harness.consoleControl.getAction(interrupt.id)?.status).not.toBe("finished");
    await harness.post(sessionId, "turn", { phase: "end", input: JSON.stringify({ last_assistant_message: "Interrupted" }) });
    await vi.waitFor(() => expect(harness.consoleControl.getAction(interrupt.id)).toMatchObject({ status: "finished", outcome: "interrupted" }));
    expect(harness.consoleControl.getAction(next.id)?.outcome).toBe("interrupted");
    const mismatch = harness.consoleControl.request({ kind: "operation", operationId: sessionId }, "terminal-mismatch", { kind: "send", operationId: sessionId, text: "Expected prompt" });
    await vi.waitFor(() => expect(harness.consoleControl.getAction(mismatch.id)?.status).toBe("running"));
    await harness.post(sessionId, "turn", { phase: "start", input: JSON.stringify({ prompt: "Someone else's prompt" }) });
    expect(harness.consoleControl.getAction(mismatch.id)?.status).toBe("outcome_unknown");
    await fs.appendFile(path.join(harness.fleetDataDir, "projects", "-tmp-workspace", "sid-live.jsonl"), "\n" + JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "private thought" }, { type: "text", text: "Fresh terminal result" }] } }) + "\n");
    await harness.post(sessionId, "turn", { phase: "end", input: "{}" });
    await vi.waitFor(() => expect(harness.consoleControl.observe(sessionId)?.output.source).toBe("terminal_transcript"));
    expect(harness.consoleControl.observe(sessionId)?.output.text).toContain("Fresh terminal result");
    expect(harness.consoleControl.observe(sessionId)?.output.text).not.toContain("private thought");
    const launch = harness.consoleControl.request({ kind: "operation", operationId: sessionId }, "terminal-launch", { kind: "launch", theaterId: "theater-1", text: "Launch terminal check", viewMode: "terminal" });
    await vi.waitFor(() => expect(harness.consoleControl.getAction(launch.id)?.operationId).toBeDefined());
    const launched = harness.consoleControl.getAction(launch.id)!.operationId!;
    harness.setLive(launched);
    expect(harness.consoleControl.getAction(launch.id)?.status).toBe("running");
    await harness.post(launched, "turn", { phase: "start", input: JSON.stringify({ prompt: "Launch terminal check" }) });
    await harness.post(launched, "turn", { phase: "end", input: JSON.stringify({ last_assistant_message: "Launch completed" }) });
    await vi.waitFor(() => expect(harness.consoleControl.getAction(launch.id)).toMatchObject({ status: "finished", outcome: "completed" }));
  });
  it("routes an opted-in Console message through the existing Chat session and records its result", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);
    harness.attachProviderSession(sessionId);
    harness.allowConsoleUse(sessionId);
    await harness.post(sessionId, "chat");
    const receipt = harness.consoleControl.request({ kind: "operation", operationId: sessionId }, "console-message", { kind: "send", operationId: sessionId, text: "Inspect the build" });
    expect(harness.sends).toEqual([]);
    await vi.waitFor(() => expect(harness.consoleControl.getAction(receipt.id)?.status).toBe("finished"));
    expect(harness.sends).toEqual(["Inspect the build"]);
    expect(harness.sdkOptions[0]?.executablePath).toBe(resolveAgentCliBinary({ cliCommand: "claude", env: process.env, userPaths: {} }).resolved?.bin);
    expect(harness.consoleControl.getAction(receipt.id)).toMatchObject({ outcome: "succeeded", operationId: sessionId });
    expect(harness.consoleControl.observe(sessionId)?.output.text).toContain("continuing");
    const launch = harness.consoleControl.request({ kind: "operation", operationId: sessionId }, "console-launch", { kind: "launch", theaterId: "theater-1", text: "Run the next check", viewMode: "chat" });
    await vi.waitFor(() => expect(harness.consoleControl.getAction(launch.id)?.status).toBe("finished"));
    const launched = harness.consoleControl.getAction(launch.id)!;
    expect(launched.operationId).not.toBe(sessionId);
    expect(harness.operation(launched.operationId!)?.payload.chatBorn).toBe(true);
    expect(harness.sends).toEqual(["Inspect the build", "Run the next check"]);
    const command = harness.consoleControl.request({ kind: "operation", operationId: sessionId }, "console-command", { kind: "send", operationId: sessionId, text: "/compact" });
    await vi.waitFor(() => expect(harness.consoleControl.getAction(command.id)).toMatchObject({ status: "finished", outcome: "succeeded" }));
  });
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

  it("interrupts a running terminal turn when converting to chat", async () => {
    const harness = await createHarness();
    const sessionId = await harness.createSession();
    harness.setLive(sessionId);
    harness.attachProviderSession(sessionId);
    await harness.post(sessionId, "turn", { phase: "start" });

    await harness.post(sessionId, "chat");

    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { ok: true } });
    expect(harness.operation(sessionId)?.payload.chatMode).toBe(true);
    expect(harness.terminate).toHaveBeenCalledWith(sessionId);
    expect((await harness.sessions()).find((session) => session.sessionId === sessionId)).toMatchObject({
      chatActive: true,
      turnState: "none",
    });
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

  it.each(["pending", "missed"])("preserves first-turn identity after a %s transcript lookup at disposal", async (lookup) => {
    const harness = await createHarness({ holdChatTurn: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", harness.fleetDataDir);
    const sessionId = await harness.createSession();
    harness.attachLaunchProviderSession(sessionId);
    await harness.post(sessionId, "chat");
    let release!: () => void;
    let locating = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const readDirectory = fs.readdir.bind(fs);
    const spy = vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (args[0] === path.join(harness.fleetDataDir, "projects")) {
        locating = true;
        if (lookup === "missed" && harness.closeChat.mock.calls.length === 0) return [];
        if (lookup === "pending") await gate;
      }
      return readDirectory(...args);
    });
    try {
      await harness.post(sessionId, "message", { text: "first streaming turn" });
      await vi.waitFor(() => expect(locating).toBe(true));
      const resume = harness.post(sessionId, "resume");
      await vi.waitFor(() => expect(harness.closeChat).toHaveBeenCalled());
      release();
      await resume;
      expect(harness.responses.at(-1)?.status).toBe(200);
      expect(harness.attach).toHaveBeenLastCalledWith(expect.objectContaining({ resumeSessionId: "sid-live" }));
    } finally {
      release();
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each(["exit", "resume"])("%s interrupts streaming chat and cancels queued turns before relaunching the cli", async (action) => {
    const harness = await createHarness({ holdChatTurn: true });
    const sessionId = await harness.createSession();
    harness.attachProviderSession(sessionId);
    await harness.post(sessionId, "chat");

    await harness.post(sessionId, "message", { text: "stream until interrupted" });
    await vi.waitFor(() => expect(harness.sends).toEqual(["stream until interrupted"]));
    await harness.post(sessionId, "message", { text: "must not run after switching" });
    expect((await harness.sessions()).find((session) => session.sessionId === sessionId)?.modelActivity).toBe("working");
    if (action === "exit") {
      await harness.del(sessionId, "chat");
      expect(harness.responses.at(-1)?.status).toBe(200);
      expect(harness.closeChat).toHaveBeenCalled();
    }
    await harness.post(sessionId, "resume");

    expect(harness.closeChat).toHaveBeenCalled();
    expect(harness.sends).toEqual(["stream until interrupted"]);
    expect(harness.responses.at(-1)?.status).toBe(200);
    expect(harness.operation(sessionId)?.payload.chatMode).toBeUndefined();
    expect(harness.attach).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId,
      resumeSessionId: "sid-live",
    }));
  });
});

async function createHarness(options: { readonly cliId?: string; readonly holdAttachAfterFirst?: Promise<void>; readonly holdChatTurn?: boolean } = {}) {
  const cliId = options.cliId ?? "claude-gateway";
  const fleetDataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-terminal-chat-"));
  temporaryDirectories.push(fleetDataDir);
  // 실제 Chat 런치의 cwd로 쓸 Theater 루트를 준비한다.
  mkdirSync(path.join(fleetDataDir, "theater"), { recursive: true });
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
  const sends: string[] = [];
  const closeChat = vi.fn();
  // 세션 하나가 여러 프롬프트를 받는다 — 보낼 때마다 그 턴의 메시지가 열린 스트림으로 흘러든다.
  const openSession = vi.fn(async (_request: unknown) => {
    const queue: Record<string, unknown>[] = [];
    let waiting: (() => void) | null = null;
    let closed = false;
    const wake = (): void => { const resume = waiting; waiting = null; resume?.(); };
    return {
      send: (text: string) => {
        sends.push(text);
        queue.push(
          { type: "system", subtype: "init", session_id: "sid-live" },
          { type: "assistant", message: { content: [{ type: "text", text: "continuing" }] } },
          ...(!options.holdChatTurn ? [{ type: "result", subtype: "success", is_error: false, duration_ms: 5 }] : []),
        );
        wake();
      },
      interrupt: async () => {},
      stopTask: async () => {},
      backgroundTasks: async () => true,
      getContextUsage: async () => null,
      close: () => { closeChat(); closed = true; wake(); },
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Record<string, unknown>>> {
            for (;;) {
              const next = queue.shift();
              if (next !== undefined) return { done: false, value: next };
              if (closed) return { done: true, value: undefined };
              await new Promise<void>((resolve) => { waiting = resolve; });
            }
          },
        };
      },
    };
  });
  const sdkOptions: Array<{ readonly executablePath?: string }> = [];
  (globalThis as { __fleetAgentChatSdkFactory?: unknown }).__fleetAgentChatSdkFactory = async (options: { readonly models: readonly string[]; readonly executablePath?: string }) => {
    sdkOptions.push(options);
    return { configDir: sdkConfigDir, models: options.models, openSession, dispose: async () => {} };
  };

  const operations: OperationNode[] = [];
  const responses: Array<{ readonly status: number; readonly body: unknown }> = [];
  const writes: string[] = [];
  const lifecycleCleanups: Array<() => void | Promise<void>> = [];
  const liveSessions = new Set<string>();
  let route: RouteHandler | undefined;
  const tickets = createPluginTerminalTicketRegistry();
  let chatAttach: Parameters<TerminalRuntime["bindChatAttach"]>[0] | null = null;
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
    bindChatAttach: (attachChat) => {
      chatAttach = attachChat;
      return () => {
        if (chatAttach === attachChat) chatAttach = null;
      };
    },
    stop: async () => {},
  };
  const consoleControl = createConsoleControl({ enabled: () => true, directory: path.join(fleetDataDir, "console-use"), operations: () => operations, theaters: () => [{ id: "theater-1", name: "Project" }] });
  lifecycleCleanups.push(() => consoleControl.dispose());
  const ctx = {
    consoleControl,
    dataDir: fleetDataDir,
    legacyDataDir: fleetDataDir,
    basePath: "/api/v1",
    wsBasePath: "/api/v1/terminal/ws",
    registerRouter: (_path: string, handler: RouteHandler) => { route = handler; },
    registerWsHandler: () => {},
    host: {
      aiGatewayMcp: { connect: () => ({ embeddedServer: {}, getEndpoint: async () => ({ servers: [] }), issueSessionToken: () => [], releaseSessionToken: () => {}, cleanup: () => {}, dispose: async () => {} }) },
      admiralMcp: { connect: () => ({
        getEndpoint: async () => ({ servers: [] }), issueSessionToken: () => [],
        releaseSessionToken: () => {}, cleanup: () => {},
      }) },
      consoleUse: { connect: () => ({
        embeddedServer: {},
        getEndpoint: async () => ({ servers: [] }),
        issueSessionToken: () => [],
        releaseSessionToken: () => {},
        cleanup: () => {},
        dispose: async () => {},
      }) },
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
      },
      events: {
        publish: () => {},
        subscribe: () => () => {},
        registerSseChannel: () => () => {},
      },
      server: { origin: () => "http://127.0.0.1:4400" },
      paths: {
        fleetDataDir,
        resolveTheaterPath: (theaterId: string) => theaterId === "theater-1" ? path.join(fleetDataDir, "theater") : null,
        canonicalizeTheaterPath: (cwd: string) => cwd,
        workspaceHash: () => "theater-1",
        ensureWorkspaceDirectory: (cwd: string) => ({ path: `/tmp/ws/${cwd.replace(/\W+/g, "-")}`, id: "ws" }),
        withDirectoryLock: <T,>(_lockDir: string, operation: () => T): T => operation(),
      },
      http: {
        writeJson: (_res: http.ServerResponse, status: number, responseBody: unknown) => { responses.push({ status, body: responseBody }); },
        readJsonBody: async <T,>(req: http.IncomingMessage) => ((req as TestRequest).__body ?? { theaterId: "theater-1", cliId }) as T,
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
      req: { method, url: `/api/v1/agent/sessions/${sessionId}/${action}`, ...(body ? { __body: body } : {}), on: () => {} } as unknown as TestRequest,
      res: res ?? ({} as http.ServerResponse),
      pathname: `/api/v1/agent/sessions/${sessionId}/${action}`,
    });
  }

  return {
    consoleControl,
    sdkOptions,
    fleetDataDir,
    attach,
    terminate,
    openSession,
    closeChat,
    sends,
    responses,
    writes,
    operation: (id: string) => operations.find((operation) => operation.id === id),
    createSession: async (): Promise<string> => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "POST", url: "/api/v1/agent/sessions" } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: "/api/v1/agent/sessions",
      });
      const operation = operations[0];
      if (!operation) throw new Error(`Session create failed: ${JSON.stringify(responses.at(-1))}`);
      return operation.id;
    },
    sessions: async (): Promise<readonly Record<string, unknown>[]> => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "GET", url: "/api/v1/agent/sessions" } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: "/api/v1/agent/sessions",
      });
      const body = responses.at(-1)?.body as { readonly sessions?: readonly Record<string, unknown>[] } | undefined;
      return body?.sessions ?? [];
    },
    post: (sessionId: string, action: string, body?: Record<string, unknown>) => dispatch("POST", sessionId, action, body),
    del: (sessionId: string, action: string) => dispatch("DELETE", sessionId, action),
    get: (sessionId: string, action: string) => dispatch("GET", sessionId, action),
    tickets,
    postTicket: async (sessionId: string, extra: Record<string, unknown> = {}): Promise<void> => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "POST", url: "/api/v1/agent/ticket", __body: { operationId: sessionId, ...extra } } as unknown as TestRequest,
        res: {} as http.ServerResponse,
        pathname: "/api/v1/agent/ticket",
      });
    },
    openChatSocket: async (sessionId: string): Promise<Array<{ seq: number; event: { kind: string } }>> => {
      if (!route) throw new Error("Agent route was not registered");
      await route({
        req: { method: "POST", url: "/api/v1/agent/ticket", __body: { operationId: sessionId, channel: "chat" } } as unknown as TestRequest,
        res: {} as http.ServerResponse,
        pathname: "/api/v1/agent/ticket",
      });
      const ticket = (responses.at(-1)?.body as { readonly ticket?: string } | undefined)?.ticket;
      if (!ticket) throw new Error("Chat ticket was not issued");
      const context = tickets.consume(ticket);
      if (!context || !chatAttach) throw new Error("Chat attach was not bound");
      const frames: Array<{ seq: number; event: { kind: string } }> = [];
      const socket = createTestChatSocket((raw) => {
        const parsed = JSON.parse(raw) as { seq?: number; event?: { kind: string } };
        if (typeof parsed.seq === "number" && parsed.event) frames.push({ seq: parsed.seq, event: parsed.event });
      });
      chatAttach(socket, context);
      await vi.waitFor(() => {
        expect(frames.some((frame) => frame.event.kind === "replay-end")).toBe(true);
      });
      return frames;
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
    /** Console 실행 경로를 보려면 그 Operation이 콘솔 사용을 허용받고 있어야 한다. */
    allowConsoleUse: (sessionId: string) => {
      const operation = operations.find((candidate) => candidate.id === sessionId);
      if (!operation) throw new Error("Operation not found");
      operation.payload.consoleUse = { enabled: true, language: "en" };
    },
    attachProviderSession: (sessionId: string) => {
      const operation = operations.find((candidate) => candidate.id === sessionId);
      if (!operation) throw new Error("Operation not found");
      operation.payload.session = {
        ...(operation.payload.session as Record<string, unknown> | undefined),
        harness: "claude-code",
        id: "sid-live",
        transcriptPath,
        capturedAt: "2026-08-14T00:00:00.000Z",
      };
    },
    /** 런치 시점에 미리 심는 좌표 — 첫 prompt capture나 transcript가 아직 없는 상태다. */
    attachLaunchProviderSession: (sessionId: string) => {
      const operation = operations.find((candidate) => candidate.id === sessionId);
      if (!operation) throw new Error("Operation not found");
      operation.payload.session = {
        ...(operation.payload.session as Record<string, unknown> | undefined),
        harness: "claude-code",
        id: "sid-live",
        source: "launch",
        capturedAt: "2026-08-14T00:00:00.000Z",
      };
    },
  };
}
