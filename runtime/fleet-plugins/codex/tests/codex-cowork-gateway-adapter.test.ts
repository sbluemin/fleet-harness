import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaudeGatewayMessage, ClaudeGatewayRun, ClaudeGatewaySdk, ClaudeGatewayTurn } from "@dotobokuri/core-agent/claude";
import type { CoworkAgentClient, CoworkConnectOptions } from "@dotobokuri/fleet-wiki/cowork";

import { createCoworkGatewayConnector } from "../server/codex/cowork/gateway-adapter.js";

const BASE_URL = "http://127.0.0.1:43210/plugins/terminal/ai-gateway";
const TURN_WATCHDOG_MS = 10 * 60 * 1000;
const COWORK_DISALLOWED_TOOLS = [
  "Bash", "BashOutput", "KillShell",
  "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebSearch",
  "Task", "Agent", "Workflow", "Skill", "SendMessage",
  "EnterWorktree", "ExitWorktree",
  "TodoWrite", "SlashCommand", "Artifact",
];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createCoworkGatewayConnector", () => {
  it("throws before SDK creation when the gateway is not listening", async () => {
    const createSdk = vi.fn();
    const connector = createCoworkGatewayConnector({ baseUrl: () => null, createSdk });
    await expect(connector.connect(connectOptions())).rejects.toThrow("cowork_gateway_unavailable");
    expect(createSdk).not.toHaveBeenCalled();
  });

  it("preserves the local turn policy and never resumes a child session", async () => {
    const sdk = new FakeSdk([
      { type: "system", subtype: "init", session_id: "child-session" },
      resultMessage(),
    ]);
    const { client } = await connectClient(sdk, {
      effort: "low",
      mcpServers: [
        {
          name: "cowork",
          url: "http://127.0.0.1:9/mcp",
          headers: [{ name: "Authorization", value: "Bearer x" }, { name: 1, value: "drop" }],
          toolTimeoutSeconds: 30,
        },
        { name: "broken" },
        null,
      ],
      allowedToolIds: ["wiki_draft_read", "wiki_read"],
    });
    await client.sendMessage("first");
    await client.sendMessage("second");
    expect(sdk.startTurn).toHaveBeenCalledTimes(2);
    for (const [turn] of sdk.startTurn.mock.calls) {
      expect(turn.resume).toBeUndefined();
      expect(Object.hasOwn(turn, "resume")).toBe(false);
      expect(turn.prompt).toBe(turn === sdk.startTurn.mock.calls[0]?.[0] ? "first" : "second");
      expect(turn.systemPrompt).toEqual({ mode: "replace", text: "You are Fleet Wiki Cowork" });
      expect(turn.cwd).toBe("/tmp/cowork");
      expect(turn.disallowedTools).toEqual(COWORK_DISALLOWED_TOOLS);
      expect(turn.permissionMode).toBe("dontAsk");
      expect(turn.includePartialMessages).toBe(true);
      expect(turn.effort).toBe("low");
      expect(turn.servedMcpServers).toEqual([{
        name: "cowork",
        url: "http://127.0.0.1:9/mcp",
        headers: [{ name: "Authorization", value: "Bearer x" }],
        toolTimeoutSeconds: 30,
      }]);
      expect(turn.allowedTools).toEqual([
        "mcp__cowork__wiki_draft_read",
        "mcp__cowork__wiki_read",
      ]);
    }
    await client.disconnect();
  });

  it("streams text, ignores thinking, and never exposes a child session id", async () => {
    const sdk = new FakeSdk([
      { type: "system", subtype: "init", session_id: "child-session" },
      thinkingDelta("hmm"),
      textDelta("hi"),
      thinkingDelta(""),
      textDelta(""),
      resultMessage(),
    ]);
    const { client, events } = await connectClient(sdk);
    await client.sendMessage("hello");
    expect(events).toEqual([
      { type: "messageChunk", text: "hi" },
      { type: "promptComplete" },
    ]);
    expect(JSON.stringify(events)).not.toContain("child-session");
    await client.disconnect();
  });

  it("emits promptComplete on success and the failed detail or cowork_turn_failed exactly once", async () => {
    const success = new FakeSdk([resultMessage(), textDelta("late"), resultMessage("again")]);
    const { client, events } = await connectClient(success);
    await client.sendMessage("hello");
    expect(events).toEqual([{ type: "promptComplete" }]);
    await client.disconnect();

    const failed = new FakeSdk([{ type: "result", is_error: true, result: "denied" }, { type: "result", is_error: true, result: "again" }]);
    const second = await connectClient(failed);
    await second.client.sendMessage("hello");
    expect(second.events).toEqual([{ type: "error", error: { message: "denied" } }]);
    await second.client.disconnect();

    const fallback = new FakeSdk([{ type: "result", is_error: true, result: { nested: true } }]);
    const third = await connectClient(fallback);
    await third.client.sendMessage("hello");
    expect(third.events).toEqual([{ type: "error", error: { message: "cowork_turn_failed" } }]);
    await third.client.disconnect();
  });
});

async function connectClient(
  sdk: FakeSdk,
  options?: Partial<CoworkConnectOptions>,
  baseUrl: string | null = BASE_URL,
): Promise<{ client: CoworkAgentClient; events: unknown[] }> {
  const connector = createCoworkGatewayConnector({
    baseUrl: () => baseUrl,
    createSdk: async (args) => sdk.create(args),
  });
  const client = await connector.connect(connectOptions(options));
  const events: unknown[] = [];
  listen(client, events);
  return { client, events };
}

function listen(client: CoworkAgentClient, events: unknown[]): void {
  client.on("messageChunk", (text) => { events.push({ type: "messageChunk", text }); });
  client.on("toolCall", (title, status) => { events.push({ type: "toolCall", title, status }); });
  client.on("toolCallUpdate", (title, status) => { events.push({ type: "toolCallUpdate", title, status }); });
  client.on("promptComplete", () => { events.push({ type: "promptComplete" }); });
  client.on("error", (error) => { events.push({ type: "error", error }); });
}

function connectOptions(overrides: Partial<CoworkConnectOptions> = {}): CoworkConnectOptions {
  return {
    cwd: "/tmp/cowork",
    systemPrompt: "You are Fleet Wiki Cowork",
    mcpServers: [{ name: "cowork", url: "http://127.0.0.1:9/mcp" }],
    allowedToolIds: ["wiki_draft_read", "wiki_read"],
    ...overrides,
  };
}

class FakeSdk {
  createArgs: unknown = null;
  readonly configDir = "/tmp/fake";
  readonly models = ["sonnet"];
  readonly dispose = vi.fn(async () => undefined);
  readonly startTurn: ReturnType<typeof vi.fn>;

  constructor(stream: readonly ClaudeGatewayMessage[] = [resultMessage()]) {
    this.startTurn = vi.fn(async (_turn: ClaudeGatewayTurn) => immediateRun(stream));
  }

  create(args: unknown): ClaudeGatewaySdk {
    this.createArgs = args;
    return this as unknown as ClaudeGatewaySdk;
  }
}

function immediateRun(
  messages: readonly ClaudeGatewayMessage[],
  iterateError?: unknown,
): ClaudeGatewayRun & { readonly close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  return {
    close,
    getContextUsage: async () => null,
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
      if (iterateError !== undefined) throw iterateError;
    },
  };
}

function hangingRun(options: { throwOnClose?: boolean } = {}): ClaudeGatewayRun & {
  readonly close: ReturnType<typeof vi.fn>;
  readonly started: Promise<void>;
} {
  let closed = false;
  const gate = deferred<void>();
  const started = deferred<void>();
  const close = vi.fn(() => {
    closed = true;
    gate.resolve();
  });
  return {
    close,
    getContextUsage: async () => null,
    started: started.promise,
    async *[Symbol.asyncIterator]() {
      started.resolve();
      if (!closed) await gate.promise;
      if (options.throwOnClose) throw new Error("run closed");
    },
  };
}

function resultMessage(result?: string): ClaudeGatewayMessage {
  return {
    type: "result",
    is_error: false,
    session_id: "child-session",
    ...(result === undefined ? {} : { result }),
  };
}

function textDelta(text: string): ClaudeGatewayMessage {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } };
}

function thinkingDelta(thinking: string): ClaudeGatewayMessage {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } } };
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
