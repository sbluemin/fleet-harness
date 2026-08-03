import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UnifiedAgent,
  type AcpPermissionRequestParams,
  type IUnifiedAgentClient,
} from "@dotobokuri/core-unified-agent";
import { afterEach, expect, it, vi } from "vitest";

import { AnalystSession } from "../src/session.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([
  ["claude", true],
  ["codex", false],
] as const)("builds the selected %s Analyst provider with capability-aware isolation", async (cliId, strictMcp) => {
  const file = join(await mkdtemp(join(tmpdir(), "analyst-provider-")), "capture.jsonl");
  await writeFile(file, "");
  const client = Object.assign(new EventEmitter(), {
    connect: vi.fn().mockResolvedValue(undefined),
    cancelPrompt: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }) as unknown as IUnifiedAgentClient;
  const build = vi.spyOn(UnifiedAgent, "build").mockResolvedValue(client);
  const session = new AnalystSession({
    capturePath: file,
    cwd: process.cwd(),
    cliId,
    cliPath: "/configured/agent-cli",
    env: { PATH: "/isolated/bin", CLAUDE_BIN: "/configured/agent-cli" },
    model: "test-model",
  });

  await session.start();

  expect(build).toHaveBeenCalledWith({ cli: cliId });
  expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({
    autoApprove: true,
    fsAccess: false,
    yoloMode: true,
    strictMcp,
    cliPath: "/configured/agent-cli",
    env: { PATH: "/isolated/bin", CLAUDE_BIN: "/configured/agent-cli" },
  }));
  await session.dispose();
});

it("pins Korean output language in the provider system prompt at connect time", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "analyst-language-")), "capture.jsonl");
  await writeFile(file, "");
  const connect = vi.fn().mockResolvedValue(undefined);
  const client = Object.assign(new EventEmitter(), {
    connect,
    cancelPrompt: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }) as unknown as IUnifiedAgentClient;
  vi.spyOn(UnifiedAgent, "build").mockResolvedValue(client);
  const session = new AnalystSession({ capturePath: file, cwd: process.cwd(), cliId: "claude", model: "test-model", language: "ko" });

  await session.start();

  const systemPrompt = connect.mock.calls[0]?.[0]?.systemPrompt as string;
  expect(systemPrompt).toContain("\n\n# Language\nWrite every user-facing response in Korean (한국어): answers, follow-up suggestions, artifact titles, and artifact body text. Keep code, commands, file paths, identifiers, and protocol tokens in their original form.");
  await session.dispose();
});

it("rejects sends before start and disposes idempotently", async () => {
  const session = new AnalystSession({
    capturePath: "/not-used-before-start.jsonl",
    cwd: process.cwd(),
    cliId: "claude",
    model: "test-model",
  });

  await expect(session.send("hello")).rejects.toThrow("Session not started");
  await expect(session.dispose()).resolves.toBeUndefined();
  await expect(session.dispose()).resolves.toBeUndefined();
});

it("bridges provider exits as analysis_exited errors", () => {
  const events: unknown[] = [];
  const session = new AnalystSession({
    capturePath: "/not-used.jsonl",
    cwd: process.cwd(),
    cliId: "claude",
    model: "test-model",
    onEvent: event => events.push(event),
  });
  const client = new EventEmitter() as unknown as IUnifiedAgentClient;

  (session as unknown as { bridge(value: IUnifiedAgentClient): void }).bridge(client);
  (client as unknown as EventEmitter).emit("exit", 7, "SIGTERM");

  expect(events).toEqual([{
    type: "error",
    error: { code: "analysis_exited", message: "Analysis process exited (code 7, signal SIGTERM)" },
  }]);
});

it("allows only explicitly qualified session_analyst MCP tools and rejects native tools", () => {
  const session = new AnalystSession({
    capturePath: "/not-used.jsonl",
    cwd: process.cwd(),
    cliId: "claude",
    model: "test-model",
  });
  const client = new EventEmitter() as unknown as IUnifiedAgentClient;
  const allow = vi.fn();
  const reject = vi.fn();
  const options = [
    { optionId: "allow", name: "Allow", kind: "allow_once" as const },
    { optionId: "reject", name: "Reject", kind: "reject_once" as const },
  ];

  (session as unknown as { bridge(value: IUnifiedAgentClient): void }).bridge(client);
  (client as unknown as EventEmitter).emit("permissionRequest", permissionRequest("mcp__session_analyst__session_outline", options), allow);
  (client as unknown as EventEmitter).emit("permissionRequest", permissionRequest("shell", options), reject);

  expect(allow).toHaveBeenCalledWith({ outcome: { outcome: "selected", optionId: "allow" } });
  expect(reject).toHaveBeenCalledWith({ outcome: { outcome: "selected", optionId: "reject" } });
});

it("redacts provider text, thought, tool titles, and errors at the outbound bridge", () => {
  const events: unknown[] = [];
  const session = new AnalystSession({
    capturePath: "/not-used.jsonl",
    cwd: process.cwd(),
    cliId: "claude",
    model: "test-model",
    onEvent: event => events.push(event),
  });
  const client = new EventEmitter() as unknown as IUnifiedAgentClient;

  (session as unknown as { bridge(value: IUnifiedAgentClient): void }).bridge(client);
  const emitter = client as unknown as EventEmitter;
  emitter.emit("messageChunk", "MY_APP_PASSWORD=chunk-secret", "session-id");
  emitter.emit("thoughtChunk", "Bearer thought-secret-value", "session-id");
  emitter.emit("toolCall", "uses ses_tool-secret", "pending", "session-id");
  emitter.emit("error", new Error("Authorization: Basic ZXJyb3I6c2VjcmV0"));

  const exposed = JSON.stringify(events);
  for (const secret of ["chunk-secret", "thought-secret-value", "ses_tool-secret", "ZXJyb3I6c2VjcmV0"]) {
    expect(exposed).not.toContain(secret);
  }
  expect(events).toHaveLength(4);
});

it("registers a client before connect so concurrent disposal owns a pending connection", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "analyst-session-")), "capture.jsonl");
  await writeFile(file, "");
  const never = new Promise<never>(() => undefined);
  const emitter = new EventEmitter();
  const connect = vi.fn((_options: unknown) => never);
  const client = Object.assign(emitter, {
    connect,
    cancelPrompt: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }) as unknown as IUnifiedAgentClient;
  vi.spyOn(UnifiedAgent, "build").mockResolvedValue(client);
  const session = new AnalystSession({
    capturePath: file,
    cwd: process.cwd(),
    cliId: "claude",
    model: "test-model",
  });

  void session.start();
  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({
    autoApprove: true,
    fsAccess: false,
    yoloMode: true,
    strictMcp: true,
  }));

  await session.dispose();
  expect(client.cancelPrompt).toHaveBeenCalledOnce();
  expect(client.disconnect).toHaveBeenCalledOnce();
});

it("cancels an active turn, bounds disposal, and rejects sends once disposal begins", async () => {
  vi.useFakeTimers();
  const never = new Promise<never>(() => undefined);
  const client = {
    cancelPrompt: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(() => never),
  } as unknown as IUnifiedAgentClient;
  const session = new AnalystSession({
    capturePath: "/not-used.jsonl",
    cwd: process.cwd(),
    cliId: "claude",
    model: "test-model",
  });
  const state = session as unknown as { client: IUnifiedAgentClient; started: boolean };
  state.client = client;
  state.started = true;
  void session.send("long prompt");
  await Promise.resolve();

  const disposal = session.dispose();
  expect(client.cancelPrompt).toHaveBeenCalledOnce();
  await expect(session.send("too late")).rejects.toThrow("Session disposed");
  expect(client.disconnect).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(2_000);
  await disposal;
  expect(client.disconnect).toHaveBeenCalledOnce();
});

function permissionRequest(
  title: string,
  options: AcpPermissionRequestParams["options"],
): AcpPermissionRequestParams {
  return {
    sessionId: "session-id",
    toolCall: { toolCallId: title, title },
    options,
  };
}
