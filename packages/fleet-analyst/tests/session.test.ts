import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClaudeGatewayMessage, ClaudeGatewaySdk, ClaudeGatewayTurn } from "@dotobokuri/core-agent/claude";
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
  readonly startTurn: ReturnType<typeof vi.fn>;

  constructor(stream: readonly ClaudeGatewayMessage[] = [{ type: "result", subtype: "success", is_error: false, session_id: "child-session" }]) {
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
  // 앞선 ACP 경로는 도구 이름을 접두사로 알아보고 shell 같은 native 도구를 거부했다. 이제
  // 내장 도구가 아예 없으므로 거부할 것이 남지 않는다.
  const { analyst, sdk } = await session();
  await analyst.start();
  await analyst.send("hello");
  const turn = sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn;
  expect(turn.tools).toEqual([]);
  expect(turn.permissionMode).toBe("dontAsk");
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
  // ACP 기본값 prepend는 이 프롬프트를 첫 사용자 메시지 본문에 실었다. 그러면 프롬프트 안의
  // 안티-인젝션 조항이 자기가 삼키는 transcript와 같은 층위에 놓인다.
  const { analyst, sdk } = await session();
  await analyst.start();
  await analyst.send("hello");
  const turn = sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn;
  expect(turn.systemPrompt?.mode).toBe("replace");
  expect(turn.systemPrompt?.text).toContain("You are Session Analyst");
  await analyst.dispose();
});

it("pins Korean output language in the system prompt", async () => {
  const { analyst, sdk } = await session({ language: "ko" });
  await analyst.start();
  await analyst.send("hello");
  const turn = sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn;
  expect(turn.systemPrompt?.text).toContain("\n\n# Language\nWrite every user-facing response in Korean (한국어): answers, follow-up suggestions, artifact titles, and artifact body text. Keep code, commands, file paths, identifiers, and protocol tokens in their original form.");
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
  expect((sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn).resume).toBeUndefined();
  expect((sdk.startTurn.mock.calls[1]?.[0] as ClaudeGatewayTurn).resume).toBe("child-session");
  await analyst.dispose();
});

it("rejects sends before start and disposes idempotently", async () => {
  const { analyst } = await session();
  await expect(analyst.send("hello")).rejects.toThrow("Session not started");
  await expect(analyst.dispose()).resolves.toBeUndefined();
  await expect(analyst.dispose()).resolves.toBeUndefined();
});

it("cancels an active turn on disposal and rejects later sends", async () => {
  const { analyst, sdk } = await session();
  await analyst.start();
  void analyst.send("long prompt");
  await Promise.resolve();
  await analyst.dispose();
  await expect(analyst.send("too late")).rejects.toThrow("Session disposed");
  expect(sdk.dispose).toHaveBeenCalledOnce();
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

it("redacts text, thought, and tool titles on the way out", () => {
  const names = new Map<string, string>();
  const redact = (value: string) => value.replace(/chunk-secret|thought-secret-value|ses_tool-secret/g, "[redacted]");
  const emitted = [
    ...toAnalystEvents(delta("text_delta", { text: "MY_APP_PASSWORD=chunk-secret" }), names, redact),
    ...toAnalystEvents(delta("thinking_delta", { thinking: "Bearer thought-secret-value" }), names, redact),
    ...toAnalystEvents({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "ses_tool-secret" }] } }, names, redact),
  ];
  const exposed = JSON.stringify(emitted);
  for (const secret of ["chunk-secret", "thought-secret-value", "ses_tool-secret"]) {
    expect(exposed).not.toContain(secret);
  }
  expect(emitted.map((event) => event.type)).toEqual(["chunk", "thought", "tool"]);
});

it("keeps assistant text and reasoning on separate event kinds", () => {
  const identity = (value: string): string => value;
  expect(toAnalystEvents(delta("text_delta", { text: "hi" }), new Map(), identity)).toEqual([{ type: "chunk", text: "hi" }]);
  expect(toAnalystEvents(delta("thinking_delta", { thinking: "hmm" }), new Map(), identity)).toEqual([{ type: "thought", text: "hmm" }]);
});

function delta(type: string, payload: Record<string, unknown>): ClaudeGatewayMessage {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type, ...payload } } };
}
