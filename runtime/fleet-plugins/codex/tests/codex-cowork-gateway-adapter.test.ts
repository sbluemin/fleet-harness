import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaudeGatewayMessage, ClaudeGatewayRun, ClaudeGatewaySdk, ClaudeGatewayTurn } from "@dotobokuri/core-agent/claude";
import type { CoworkAgentClient, CoworkConnectOptions } from "@dotobokuri/fleet-wiki/cowork";

import { createCoworkGatewayConnector } from "../core/host/codex/cowork/gateway-adapter.js";

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

  it("starts the common loop during connect and binds the SDK to the host gateway", async () => {
    const sdk = new FakeSdk();
    const { client } = await connectClient(sdk, { model: "opus" });
    expect(sdk.createArgs).toEqual({ baseUrl: BASE_URL, models: ["opus"] });
    await client.sendMessage("hello");
    expect(sdk.startTurn).toHaveBeenCalledOnce();
    await client.disconnect();
  });

  it("falls the model back to sonnet and forwards only a valid gateway effort", async () => {
    const sdk = new FakeSdk();
    const { client } = await connectClient(sdk, { model: "", effort: "high" });
    await client.sendMessage("hello");
    expect(sdk.createArgs).toEqual({ baseUrl: BASE_URL, models: ["sonnet"] });
    expect(sdk.startTurn.mock.calls[0]?.[0].model).toBe("sonnet");
    expect(sdk.startTurn.mock.calls[0]?.[0].effort).toBe("high");
    await client.disconnect();

    const other = new FakeSdk();
    const second = await connectClient(other, { effort: "turbo" });
    await second.client.sendMessage("hello");
    expect(other.startTurn.mock.calls[0]?.[0].effort).toBeUndefined();
    await second.client.disconnect();
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

  it("pairs tool ids and falls the name back to tool on done and error", async () => {
    const sdk = new FakeSdk([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "wiki_draft_read", input: {} },
            { type: "tool_use", id: "t2", input: {} },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", is_error: false },
            { type: "tool_result", tool_use_id: "t2", is_error: true },
            { type: "tool_result", tool_use_id: "missing", is_error: true },
            { type: "tool_result", is_error: false },
          ],
        },
      },
      resultMessage(),
    ]);
    const { client, events } = await connectClient(sdk);
    await client.sendMessage("hello");
    expect(events).toEqual([
      { type: "toolCall", title: "wiki_draft_read", status: "running" },
      { type: "toolCall", title: "tool", status: "running" },
      { type: "toolCallUpdate", title: "wiki_draft_read", status: "done" },
      { type: "toolCallUpdate", title: "tool", status: "error" },
      { type: "toolCallUpdate", title: "tool", status: "error" },
      { type: "toolCallUpdate", title: "tool", status: "done" },
      { type: "promptComplete" },
    ]);
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

  it("emits cowork_turn_incomplete when the stream ends without a result", async () => {
    const sdk = new FakeSdk([textDelta("hi")]);
    const { client, events } = await connectClient(sdk);
    await client.sendMessage("hello");
    expect(events).toEqual([
      { type: "messageChunk", text: "hi" },
      { type: "error", error: { message: "cowork_turn_incomplete" } },
    ]);
    await client.disconnect();
  });

  it("closes the active run and emits cowork_turn_timeout exactly once after ten minutes", async () => {
    vi.useFakeTimers();
    const hanging = hangingRun({ throwOnClose: true });
    const sdk = new FakeSdk();
    sdk.startTurn.mockImplementation(async () => hanging);
    const { client, events } = await connectClient(sdk);
    const sending = client.sendMessage("hello");
    await hanging.started;
    await vi.advanceTimersByTimeAsync(TURN_WATCHDOG_MS - 1);
    expect(events).toEqual([]);
    expect(hanging.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await sending;
    expect(events).toEqual([{ type: "error", error: { message: "cowork_turn_timeout" } }]);
    expect(hanging.close).toHaveBeenCalledOnce();
    await client.disconnect();
    expect(hanging.close).toHaveBeenCalledOnce();
  });

  it("cancels a hanging run as a quiet control path and resets before the next send", async () => {
    const hanging = hangingRun();
    const sdk = new FakeSdk();
    sdk.startTurn
      .mockImplementationOnce(async () => hanging)
      .mockImplementationOnce(async () => immediateRun([resultMessage()]));
    const { client, events } = await connectClient(sdk);
    const sending = client.sendMessage("hello");
    await hanging.started;
    await client.cancelPrompt();
    await expect(sending).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(hanging.close).toHaveBeenCalledOnce();

    await client.sendMessage("again");
    expect(events).toEqual([{ type: "promptComplete" }]);
    expect(sdk.startTurn.mock.calls[0]?.[0].resume).toBeUndefined();
    expect(sdk.startTurn.mock.calls[1]?.[0].resume).toBeUndefined();
    expect(sdk.startTurn.mock.calls[1]?.[0].prompt).toBe("again");
    await client.disconnect();
    await client.disconnect();
    expect(sdk.dispose).toHaveBeenCalledOnce();
  });

  it("remembers cancelPrompt while startTurn is pending and resets before the next send", async () => {
    const starting = deferred<ClaudeGatewayRun>();
    const canceled = immediateRun([textDelta("late"), resultMessage()]);
    const sdk = new FakeSdk();
    sdk.startTurn
      .mockImplementationOnce(async () => starting.promise)
      .mockImplementationOnce(async () => immediateRun([resultMessage()]));
    const { client, events } = await connectClient(sdk);
    const sending = client.sendMessage("hello");
    await vi.waitFor(() => expect(sdk.startTurn).toHaveBeenCalledOnce());
    await client.cancelPrompt();
    starting.resolve(canceled);
    await expect(sending).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(canceled.close).toHaveBeenCalledOnce();

    await client.sendMessage("again");
    expect(events).toEqual([{ type: "promptComplete" }]);
    expect(sdk.startTurn.mock.calls[1]?.[0].prompt).toBe("again");
    await client.disconnect();
  });

  it("swallows a close-induced iterator throw on cancel without a terminal event", async () => {
    const hanging = hangingRun({ throwOnClose: true });
    const sdk = new FakeSdk();
    sdk.startTurn
      .mockImplementationOnce(async () => hanging)
      .mockImplementationOnce(async () => immediateRun([resultMessage()]));
    const { client, events } = await connectClient(sdk);
    const sending = client.sendMessage("hello");
    await hanging.started;
    await client.cancelPrompt();
    await expect(sending).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(hanging.close).toHaveBeenCalledOnce();

    await client.sendMessage("again");
    expect(events).toEqual([{ type: "promptComplete" }]);
    expect(sdk.startTurn.mock.calls[1]?.[0].resume).toBeUndefined();
    await client.disconnect();
  });

  it("cancels the active run and disconnects the SDK idempotently with disposed send vocabulary", async () => {
    const hanging = hangingRun();
    const sdk = new FakeSdk();
    sdk.startTurn.mockImplementation(async () => hanging);
    const { client, events } = await connectClient(sdk);
    const sending = client.sendMessage("hello");
    await hanging.started;
    await client.cancelPrompt();
    await sending;
    expect(events).toEqual([]);
    expect(hanging.close).toHaveBeenCalledOnce();
    await client.disconnect();
    await client.disconnect();
    expect(sdk.dispose).toHaveBeenCalledOnce();
    await expect(client.sendMessage("too late")).rejects.toThrow("cowork_session_disposed");
  });

  it("rejects iterator and startTurn failures without a duplicate terminal event", async () => {
    const streamDied = new FakeSdk();
    streamDied.startTurn.mockImplementation(async () => immediateRun([textDelta("hi")], new Error("stream died")));
    const first = await connectClient(streamDied);
    await expect(first.client.sendMessage("hello")).rejects.toThrow("stream died");
    expect(first.events).toEqual([{ type: "messageChunk", text: "hi" }]);
    await first.client.disconnect();

    const startFailed = new FakeSdk();
    startFailed.startTurn.mockImplementation(async () => {
      throw new Error("start failed");
    });
    const second = await connectClient(startFailed);
    await expect(second.client.sendMessage("hello")).rejects.toThrow("start failed");
    expect(second.events).toEqual([]);
    await second.client.disconnect();
  });

  it("rejects SDK creation during connect so the service can map provider unavailability", async () => {
    const connector = createCoworkGatewayConnector({
      baseUrl: () => BASE_URL,
      createSdk: async () => {
        throw new Error("sdk boom");
      },
    });
    await expect(connector.connect(connectOptions())).rejects.toThrow("sdk boom");
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
