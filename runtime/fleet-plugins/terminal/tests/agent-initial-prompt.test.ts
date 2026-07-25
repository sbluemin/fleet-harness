import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OperationCreateInput, OperationNode, OperationPatchInput } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentSession } from "../client/agent/api.js";
import { registerAgentRoutes } from "../server/agent.js";
import type { TerminalRuntime } from "../server/shared/index.js";

const cleanups: Array<() => void | Promise<void>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("agent session initial prompt", () => {
  it("injects the trimmed prompt through the delayed PTY writer without echoing it in session or Operation DTOs", async () => {
    const harness = createHarness({ initialPrompt: "  Inspect the failing test  " });
    vi.useFakeTimers();
    try {
      await harness.postSessions();
      const sessionId = harness.attach.mock.calls[0]?.[0]?.sessionId;
      expect(sessionId).toBeTypeOf("string");
      harness.emitOutput(sessionId!);
      await vi.advanceTimersByTimeAsync(1_051);

      expect(harness.attach).toHaveBeenCalledOnce();
      expect(harness.write.mock.calls.map(([_, data]) => data)).toEqual(["Inspect the failing test", "\r"]);
      expect(harness.responses.at(-1)?.status).toBe(200);
      expect(harness.responses.at(-1)?.body).not.toHaveProperty("initialPrompt");
      expect(harness.operations[0]?.payload).not.toHaveProperty("initialPrompt");
      expect(JSON.stringify(harness.responses)).not.toContain("Inspect the failing test");
      expect(JSON.stringify(harness.operations)).not.toContain("Inspect the failing test");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects prompts longer than 4000 trimmed characters", async () => {
    const harness = createHarness({ initialPrompt: "x".repeat(4_001) });

    await harness.postSessions();

    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "invalid_initial_prompt" } });
    expect(harness.attach).not.toHaveBeenCalled();
    expect(harness.operations).toHaveLength(0);
  });

  it("rejects non-string initial prompts", async () => {
    const harness = createHarness({ initialPrompt: 42 });

    await harness.postSessions();

    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "invalid_initial_prompt" } });
    expect(harness.attach).not.toHaveBeenCalled();
  });

  it("retries once after a missing PTY without terminating the session", async () => {
    const harness = createHarness({ initialPrompt: "Retry me" });
    harness.write.mockReturnValueOnce(false).mockReturnValue(true);
    vi.useFakeTimers();
    try {
      await harness.postSessions();
      const sessionId = harness.attach.mock.calls[0]?.[0]?.sessionId;
      harness.emitOutput(sessionId!);
      await vi.advanceTimersByTimeAsync(1_551);

      expect(harness.write.mock.calls.map(([_, data]) => data)).toEqual(["Retry me", "Retry me", "\r"]);
      expect(harness.terminate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the prompt gated while PTY output continues before the 800ms quiet window", async () => {
    const harness = createHarness({ initialPrompt: "Wait for quiet" });
    vi.useFakeTimers();
    try {
      await harness.postSessions();
      const sessionId = harness.attach.mock.calls[0]?.[0]?.sessionId;
      harness.emitOutput(sessionId!);

      await vi.advanceTimersByTimeAsync(799);
      expect(harness.write).not.toHaveBeenCalled();
      harness.emitOutput(sessionId!);

      await vi.advanceTimersByTimeAsync(799);
      expect(harness.write).not.toHaveBeenCalled();
      harness.emitOutput(sessionId!);

      await vi.advanceTimersByTimeAsync(799);
      expect(harness.write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.write.mock.calls.map(([_, data]) => data)).toEqual(["Wait for quiet"]);
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.write.mock.calls.map(([_, data]) => data)).toEqual(["Wait for quiet", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to prompt injection after the 15 second readiness timeout", async () => {
    const harness = createHarness({ initialPrompt: "Timeout fallback" });
    vi.useFakeTimers();
    try {
      await harness.postSessions();

      await vi.advanceTimersByTimeAsync(14_999);
      expect(harness.write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.write.mock.calls.map(([_, data]) => data)).toEqual(["Timeout fallback"]);
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.write.mock.calls.map(([_, data]) => data)).toEqual(["Timeout fallback", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the readiness watcher without injecting when the session exits before ready", async () => {
    const harness = createHarness({ initialPrompt: "Do not inject" });
    vi.useFakeTimers();
    try {
      await harness.postSessions();
      const sessionId = harness.attach.mock.calls[0]?.[0]?.sessionId;
      harness.emitOutput(sessionId!);
      await harness.emitExit(sessionId!);

      await vi.advanceTimersByTimeAsync(15_250);
      expect(harness.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not inject a stale prompt after onExit and resume reuse the same session id", async () => {
    const harness = createHarness({ initialPrompt: "Stale prompt" });
    let exitPromise: Promise<void> | undefined;
    harness.write.mockImplementationOnce((sessionId) => {
      harness.markProviderSession(sessionId);
      exitPromise = harness.emitExit(sessionId);
      return false;
    });
    vi.useFakeTimers();
    try {
      await harness.postSessions();
      const firstAttachContext = harness.attach.mock.calls[0]?.[0];
      expect(firstAttachContext).toBeDefined();
      const sessionId = firstAttachContext!.sessionId;
      harness.emitOutput(sessionId);
      await vi.advanceTimersByTimeAsync(800);
      expect(harness.write.mock.calls.map(([_, data]) => data)).toEqual(["Stale prompt"]);
      await exitPromise;

      await harness.resumeSession(sessionId!);
      await vi.advanceTimersByTimeAsync(15_250);

      expect(harness.attach).toHaveBeenCalledTimes(2);
      expect(harness.attach.mock.calls[1]?.[0]?.sessionId).toBe(sessionId);
      expect(harness.write.mock.calls.map(([_, data]) => data)).toEqual(["Stale prompt"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("agent session client request", () => {
  it("sends initialPrompt only in the session creation JSON body", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      sessionId: "session-1",
      cwdLabel: "theater",
      status: "terminal-only",
      createdAt: 1,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await createAgentSession("theater-1", "claude", "Inspect the failure");

    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/agent/sessions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ theaterId: "theater-1", cliId: "claude", initialPrompt: "Inspect the failure" }),
    }));
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("Inspect");
  });
});

function createHarness(body: Record<string, unknown>) {
  const fleetDataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-terminal-initial-prompt-"));
  temporaryDirectories.push(fleetDataDir);
  const operations: OperationNode[] = [];
  const responses: Array<{ readonly status: number; readonly body: unknown }> = [];
  let route: RouteHandler | undefined;
  let lifecycleCleanup: (() => void | Promise<void>) | undefined;
  let outputCallback: ((operationId: string) => void) | undefined;
  let exitCallback: ((operationId: string) => void | Promise<void>) | undefined;
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
    onOutput: (callback) => {
      outputCallback = callback;
      return () => {
        if (outputCallback === callback) outputCallback = undefined;
      };
    },
    onExit: (callback) => {
      exitCallback = callback;
      return () => {
        if (exitCallback === callback) exitCallback = undefined;
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
        subscribe: () => () => {},
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
    operations,
    responses,
    terminate,
    write,
    emitOutput: (sessionId: string) => {
      if (!outputCallback) throw new Error("Terminal output callback was not registered");
      outputCallback(sessionId);
    },
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
  };
}
