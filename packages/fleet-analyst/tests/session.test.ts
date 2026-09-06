import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClaudeExecutionEvent, ClaudeGatewayMessage, ClaudeGatewaySdk, ClaudeGatewayTurn } from "@dotobokuri/core-agent/claude";
import { afterEach, expect, it, vi } from "vitest";

import { AnalystSession, toAnalystEvents } from "../src/session.js";
import type { AnalystEvent, AnalystSessionOptions } from "../src/types.js";

const BASE_URL = "http://127.0.0.1:43210/plugins/terminal/ai-gateway";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function capture(): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "analyst-session-")), "capture.jsonl");
  await writeFile(file, "");
  return file;
}

class FakeSdk {
  createArgs: unknown = null;
  readonly configDir = "/tmp/fake";
  readonly models = ["test-model"];
  readonly dispose = vi.fn(async () => undefined);
  readonly close = vi.fn();
  startTurn: ReturnType<typeof vi.fn>;

  constructor(stream: readonly ClaudeGatewayMessage[] = [resultMessage()]) {
    const close = this.close;
    this.startTurn = vi.fn(async (_turn: ClaudeGatewayTurn) => ({
      [Symbol.asyncIterator]: async function* () {
        for (const message of stream) yield message;
      },
      close,
    }));
  }

  create(args: unknown): ClaudeGatewaySdk {
    this.createArgs = args;
    return this as unknown as ClaudeGatewaySdk;
  }
}

async function session(overrides: Partial<AnalystSessionOptions> = {}, sdk = new FakeSdk()): Promise<{ analyst: AnalystSession; sdk: FakeSdk }> {
  const analyst = new AnalystSession({
    capturePath: await capture(),
    cwd: process.cwd(),
    baseUrl: BASE_URL,
    model: "test-model",
    createSdk: async (args) => sdk.create(args),
    ...overrides,
  });
  return { analyst, sdk };
}

it("binds the SDK to the host gateway and only the selected model", async () => {
  const { analyst, sdk } = await session();
  await analyst.start();
  expect(sdk.createArgs).toEqual({ baseUrl: BASE_URL, models: ["test-model"] });
  await analyst.dispose();
});

it("removes every built-in tool and admits only the analyst's own MCP tools", async () => {
  const { analyst, sdk } = await session();
  await analyst.start();
  await analyst.send("hello");
  const turn = sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn;
  expect(turn.tools).toEqual([]);
  expect(turn.permissionMode).toBe("dontAsk");
  expect(turn.includePartialMessages).toBe(true);
  expect(turn.allowedTools).toEqual([
    "mcp__session_analyst__session_outline",
    "mcp__session_analyst__session_events",
    "mcp__session_analyst__session_read",
    "mcp__session_analyst__session_diff",
    "mcp__session_analyst__live_tail",
    "mcp__session_analyst__publish_artifact",
  ]);
  expect(Object.keys(turn.mcpServers ?? {})).toEqual(["session_analyst"]);
  await analyst.dispose();
});

it("continues the same analysis by resuming the child's session", async () => {
  const { analyst, sdk } = await session();
  await analyst.start();
  await analyst.send("first");
  await analyst.send("second");
  expect((sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn).prompt).toBe("first");
  expect((sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn).resume).toBeUndefined();
  expect((sdk.startTurn.mock.calls[1]?.[0] as ClaudeGatewayTurn).prompt).toBe("second");
  expect((sdk.startTurn.mock.calls[1]?.[0] as ClaudeGatewayTurn).resume).toBe("child-session");
  await analyst.dispose();
});

it("closes an active turn on disposal and disposes the SDK once", async () => {
  const hanging = hangingRun();
  const sdk = new FakeSdk();
  sdk.startTurn = vi.fn(async () => hanging);
  const { analyst } = await session({}, sdk);
  await analyst.start();
  const sending = analyst.send("long prompt");
  await hanging.started;
  await analyst.dispose();
  await expect(sending).resolves.toBeUndefined();
  await expect(analyst.send("too late")).rejects.toThrow("Session disposed");
  expect(hanging.close).toHaveBeenCalledOnce();
  expect(sdk.dispose).toHaveBeenCalledOnce();
  await analyst.dispose();
  expect(hanging.close).toHaveBeenCalledOnce();
  expect(sdk.dispose).toHaveBeenCalledOnce();
});

it("redacts text, thought, and tool titles on the way out", () => {
  const emitted = [
    ...toAnalystEvents({ kind: "text", text: "MY_APP_PASSWORD=chunk-secret" }),
    ...toAnalystEvents({ kind: "thinking", text: "Bearer thought-secret-value" }),
    ...toAnalystEvents({ kind: "tool-start", name: "ses_tool-secret", input: {} }),
    ...toAnalystEvents({ kind: "tool-end", name: "ses_tool-secret", isError: true }),
  ];
  const exposed = JSON.stringify(emitted);
  for (const secret of ["chunk-secret", "thought-secret-value", "ses_tool-secret"]) {
    expect(exposed).not.toContain(secret);
  }
  expect(emitted.map((event) => event.type)).toEqual(["chunk", "thought", "tool", "tool"]);
});

function resultMessage(): ClaudeGatewayMessage {
  return { type: "result", subtype: "success", is_error: false, session_id: "child-session" };
}

function resultEvent(isError: boolean, detail?: string): ClaudeExecutionEvent {
  return {
    kind: "result",
    isError,
    source: "message",
    ...(detail === undefined ? {} : { detail }),
  };
}

function hangingRun(): {
  readonly close: (() => void) & { readonly mock: { readonly calls: readonly unknown[] } };
  readonly started: Promise<void>;
  [Symbol.asyncIterator](): AsyncGenerator<ClaudeGatewayMessage, void, unknown>;
} {
  let closed = false;
  const gate = deferred<void>();
  const started = deferred<void>();
  const close = vi.fn((): void => {
    closed = true;
    gate.resolve();
  });
  return {
    close,
    started: started.promise,
    async *[Symbol.asyncIterator]() {
      started.resolve();
      if (!closed) await gate.promise;
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
