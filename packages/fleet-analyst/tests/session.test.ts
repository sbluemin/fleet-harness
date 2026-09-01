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

it("carries the analyst prompt as a replace-mode system prompt, not as user content", async () => {
  const { analyst, sdk } = await session();
  await analyst.start();
  await analyst.send("hello");
  const turn = sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn;
  const systemPrompt = turn.systemPrompt;
  expect(systemPrompt?.mode).toBe("replace");
  // `preset` 모드에는 text가 없다 — 좁히지 않으면 이 단언이 컴파일되지 않는다.
  expect(systemPrompt?.mode === "replace" ? systemPrompt.text : undefined).toContain("You are Session Analyst");
  expect(turn.prompt).toBe("hello");
  expect(Object.hasOwn(turn, "resume")).toBe(false);
  await analyst.dispose();
});

it("pins Korean output language in the system prompt", async () => {
  const { analyst, sdk } = await session({ language: "ko" });
  await analyst.start();
  await analyst.send("hello");
  const turn = sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn;
  const systemPrompt = turn.systemPrompt;
  expect(systemPrompt?.mode === "replace" ? systemPrompt.text : undefined).toContain("\n\n# Language\nWrite every user-facing response in Korean (한국어): answers, follow-up suggestions, artifact titles, and artifact body text. Keep code, commands, file paths, identifiers, and protocol tokens in their original form.");
  await analyst.dispose();
});

it("forwards only an effort the gateway ladder actually carries", async () => {
  const { analyst, sdk } = await session({ effort: "low" });
  await analyst.start();
  await analyst.send("hello");
  expect((sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn).effort).toBe("low");
  await analyst.dispose();

  const other = new FakeSdk();
  const { analyst: second } = await session({ effort: "turbo" }, other);
  await second.start();
  await second.send("hello");
  expect((other.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn).effort).toBeUndefined();
  await second.dispose();
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

it("serializes queued sends and recovers after a failed turn", async () => {
  const events: AnalystEvent[] = [];
  const order: string[] = [];
  const first = hangingRun();
  const sdk = new FakeSdk();
  sdk.startTurn = vi.fn(async (turn: ClaudeGatewayTurn) => {
    order.push(turn.prompt);
    if (turn.prompt === "first") return first;
    if (turn.prompt === "bad") throw new Error("boom");
    return {
      [Symbol.asyncIterator]: async function* () {
        yield resultMessage();
      },
      close: sdk.close,
    };
  });
  const { analyst } = await session({ onEvent: (event) => events.push(event) }, sdk);
  await analyst.start();
  const firstSend = analyst.send("first");
  const secondSend = analyst.send("second");
  await first.started;
  expect(order).toEqual(["first"]);
  first.close();
  await Promise.all([firstSend, secondSend]);
  expect(order).toEqual(["first", "second"]);
  await expect(analyst.send("bad")).rejects.toThrow("boom");
  await analyst.send("good");
  expect(order).toEqual(["first", "second", "bad", "good"]);
  expect(events).toEqual([
    { type: "complete" },
    { type: "error", error: { code: "analysis_error", message: "boom" } },
    { type: "complete" },
  ]);
  await analyst.dispose();
});

it("rejects sends before start, blank prompts, and after dispose", async () => {
  const events: AnalystEvent[] = [];
  const { analyst } = await session({ onEvent: (event) => events.push(event) });
  await expect(analyst.send("hello")).rejects.toThrow("Session not started");
  await analyst.start();
  await expect(analyst.send("")).rejects.toThrow("Message required");
  await expect(analyst.send("   \n\t")).rejects.toThrow("Message required");
  await analyst.dispose();
  await expect(analyst.send("hello")).rejects.toThrow("Session disposed");
  await expect(analyst.start()).rejects.toThrow("Session disposed");
  await expect(analyst.dispose()).resolves.toBeUndefined();
  expect(events).toEqual([]);
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

it("disposes a late SDK when disposal wins start", async () => {
  const created = deferred<ClaudeGatewaySdk>();
  const creating = deferred<void>();
  const sdk = new FakeSdk();
  const analyst = new AnalystSession({
    capturePath: await capture(),
    cwd: process.cwd(),
    baseUrl: BASE_URL,
    model: "test-model",
    createSdk: async (args) => {
      sdk.create(args);
      creating.resolve();
      return created.promise;
    },
  });
  const starting = analyst.start();
  await creating.promise;
  const disposing = analyst.dispose();
  created.resolve(sdk as unknown as ClaudeGatewaySdk);
  await expect(starting).rejects.toThrow("Session disposed");
  await disposing;
  expect(sdk.dispose).toHaveBeenCalledOnce();
  await analyst.dispose();
  expect(sdk.dispose).toHaveBeenCalledOnce();
});

it("emits one analysis_error and rejects when the iterator fails", async () => {
  const events: AnalystEvent[] = [];
  const sdk = new FakeSdk();
  sdk.startTurn = vi.fn(async () => ({
    close: sdk.close,
    async *[Symbol.asyncIterator]() {
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } };
      throw new Error("stream died");
    },
  }));
  const { analyst } = await session({ onEvent: (event) => events.push(event) }, sdk);
  await analyst.start();
  await expect(analyst.send("hello")).rejects.toThrow("stream died");
  expect(events).toEqual([
    { type: "chunk", text: "hi" },
    { type: "error", error: { code: "analysis_error", message: "stream died" } },
  ]);
  await analyst.dispose();
});

it("reports a failed turn as an error event rather than a silent completion", async () => {
  const events: AnalystEvent[] = [];
  const sdk = new FakeSdk([{ type: "result", subtype: "error", is_error: true, result: "gateway refused" }]);
  const { analyst } = await session({ onEvent: (event: AnalystEvent) => events.push(event) }, sdk);
  await analyst.start();
  await analyst.send("hello");
  expect(events).toEqual([{ type: "error", error: { code: "analysis_error", message: "gateway refused" } }]);
  await analyst.dispose();
});

it("falls a result error without detail back to Analysis turn failed", async () => {
  const events: AnalystEvent[] = [];
  const sdk = new FakeSdk([{ type: "result", is_error: true }]);
  const { analyst } = await session({ onEvent: (event) => events.push(event) }, sdk);
  await analyst.start();
  await analyst.send("hello");
  expect(events).toEqual([{ type: "error", error: { code: "analysis_error", message: "Analysis turn failed" } }]);
  await analyst.dispose();
});

it("separates thinking from text and maps tools through the common loop", async () => {
  const events: AnalystEvent[] = [];
  const sdk = new FakeSdk([
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "session_outline", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
    resultMessage(),
  ]);
  const { analyst } = await session({ onEvent: (event) => events.push(event) }, sdk);
  await analyst.start();
  await analyst.send("hello");
  expect(events).toEqual([
    { type: "chunk", text: "hi" },
    { type: "thought", text: "hmm" },
    { type: "tool", title: "session_outline", status: "running" },
    { type: "tool", title: "session_outline", status: "done" },
    { type: "complete" },
  ]);
  await analyst.dispose();
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

it("keeps assistant text and reasoning on separate event kinds", () => {
  expect(toAnalystEvents({ kind: "text", text: "hi" })).toEqual([{ type: "chunk", text: "hi" }]);
  expect(toAnalystEvents({ kind: "thinking", text: "hmm" })).toEqual([{ type: "thought", text: "hmm" }]);
});

it("keeps closing tags intact while still shortening real absolute paths", () => {
  // 경로 편집기가 `</cite>`의 `/cite`를 절대경로로 오인해 `<…/cite>`로 바꿔치던
  // 라이브 결함(2026-09-01)의 회귀 가드 — 닫는 태그는 경로가 아니다.
  expect(toAnalystEvents({ kind: "text", text: "Confirmed the build <cite>e12</cite> and more <cite>e14</cite>." })).toEqual([
    { type: "chunk", text: "Confirmed the build <cite>e12</cite> and more <cite>e14</cite>." },
  ]);
  expect(toAnalystEvents({ kind: "text", text: "Read /Users/sbluemin/workspace/fleet-harness/runtime/notes.md today." })).toEqual([
    { type: "chunk", text: "Read …/runtime/notes.md today." },
  ]);
});

it("maps result errors without detail to the analysis fallback and success to complete", () => {
  expect(toAnalystEvents(resultEvent(true))).toEqual([
    { type: "error", error: { code: "analysis_error", message: "Analysis turn failed" } },
  ]);
  expect(toAnalystEvents(resultEvent(true, "denied"))).toEqual([
    { type: "error", error: { code: "analysis_error", message: "denied" } },
  ]);
  expect(toAnalystEvents(resultEvent(false, "ok"))).toEqual([{ type: "complete" }]);
  expect(toAnalystEvents({ kind: "result", isError: true, source: "watchdog" })).toEqual([
    { type: "error", error: { code: "analysis_error", message: "Analysis turn failed" } },
  ]);
  expect(toAnalystEvents({ kind: "result", isError: false, source: "incomplete" })).toEqual([{ type: "complete" }]);
});

it("falls a tool-end without a name back to tool", () => {
  expect(toAnalystEvents({ kind: "tool-end", isError: false })).toEqual([
    { type: "tool", title: "tool", status: "done" },
  ]);
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
