import { describe, expect, it, vi } from "vitest";

import type {
  ClaudeExecutionEvent,
  ClaudeGatewayMessage,
  ClaudeGatewayRun,
  ClaudeGatewaySdk,
  ClaudeGatewayTurn,
} from "@dotobokuri/core-agent/claude";

import {
  ADMIRAL_SYSTEM_PROMPTS,
  ChatSession,
  PET_TOOLS,
  SCUTTLEBUTT_AGENT,
  toChatEvents,
  type ChatEvent,
} from "../server/chat-session.js";

const CWD = "/private/fleet/plugins/scuttlebutt/workspace";
const BASE_URL = "http://127.0.0.1:43210/plugins/terminal/ai-gateway";

describe("Scuttlebutt tool boundary", () => {
  it("cuts the built-in tool set down to the two web tools and never waits for approval", async () => {
    const { session, sdk } = fakeSession();
    await session.start();
    await session.send("hello");
    const turn = sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn;
    expect(turn.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(turn.allowedTools).toEqual(["WebSearch", "WebFetch"]);
    expect(turn.tools).not.toBe(PET_TOOLS);
    expect(turn.allowedTools).not.toBe(PET_TOOLS);
    expect(turn.permissionMode).toBe("dontAsk");
    expect(PET_TOOLS).toEqual(["WebSearch", "WebFetch"]);
  });
});

describe("ChatSession", () => {
  it("runs each turn with the admiral's own prompt in replace mode on the frozen model", async () => {
    const { session, sdk } = fakeSession({ admiral: "bori" });
    await session.start();
    expect(sdk.createArgs).toEqual({ baseUrl: BASE_URL, models: ["sonnet"] });

    await session.send("hello");
    expect(sdk.startTurn.mock.calls[0]?.[0]).toEqual({
      prompt: "hello",
      model: "sonnet",
      effort: "low",
      systemPrompt: { mode: "replace", text: ADMIRAL_SYSTEM_PROMPTS.bori },
      cwd: CWD,
      tools: ["WebSearch", "WebFetch"],
      allowedTools: ["WebSearch", "WebFetch"],
      permissionMode: "dontAsk",
      includePartialMessages: true,
    });
  });

  it("continues the same conversation by resuming the child's session", async () => {
    const { session, sdk } = fakeSession();
    await session.start();
    await session.send("first");
    await session.send("second");
    expect((sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn).resume).toBeUndefined();
    expect((sdk.startTurn.mock.calls[1]?.[0] as ClaudeGatewayTurn).resume).toBe("child-session");
  });

  it("keeps the workspace path and the child's session id out of every emitted event", async () => {
    const events: ChatEvent[] = [];
    const { session } = fakeSession({
      onEvent: (event) => events.push(event),
      stream: [
        { type: "system", subtype: "init", session_id: "child-session" },
        textDelta(`See ${CWD}/result.md`),
        { type: "result", subtype: "success", is_error: false, session_id: "child-session" },
      ],
    });
    await session.start();
    await session.send("hello");
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(CWD);
    expect(serialized).not.toContain("child-session");
    expect(events).toEqual([{ type: "chunk", text: "See [workspace]/result.md" }, { type: "complete" }]);
  });

  it("reports a failed turn as an error event rather than a silent completion", async () => {
    const events: ChatEvent[] = [];
    const { session } = fakeSession({
      onEvent: (event) => events.push(event),
      stream: [{ type: "result", subtype: "error", is_error: true, result: `denied at ${CWD}` }],
    });
    await session.start();
    await session.send("hello");
    expect(events).toEqual([
      { type: "error", error: { code: "chat_error", message: "denied at [workspace]" } },
    ]);
  });

  it("falls a failed result without detail back to Chat turn failed", async () => {
    const events: ChatEvent[] = [];
    const { session } = fakeSession({
      onEvent: (event) => events.push(event),
      stream: [{ type: "result", is_error: true }],
    });
    await session.start();
    await session.send("hello");
    expect(events).toEqual([
      { type: "error", error: { code: "chat_error", message: "Chat turn failed" } },
    ]);
  });

  it("drops thinking from the session stream and keeps only assistant text", async () => {
    const events: ChatEvent[] = [];
    const { session } = fakeSession({
      onEvent: (event) => events.push(event),
      stream: [
        thinkingDelta("hmm"),
        textDelta("hi"),
        { type: "result", is_error: false },
      ],
    });
    await session.start();
    await session.send("hello");
    expect(events).toEqual([{ type: "chunk", text: "hi" }, { type: "complete" }]);
  });

  it("correlates a tool result name through the common decoder id", async () => {
    const events: ChatEvent[] = [];
    const { session } = fakeSession({
      onEvent: (event) => events.push(event),
      stream: [
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { query: "fleet console" } }] },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] },
        },
        { type: "result", is_error: false },
      ],
    });
    await session.start();
    await session.send("hello");
    expect(events).toEqual([
      { type: "tool", title: "WebSearch: fleet console", status: "running" },
      { type: "tool", title: "WebSearch", status: "done" },
      { type: "complete" },
    ]);
  });

  it("emits nothing for message kinds the SSE contract has no event for", async () => {
    const events: ChatEvent[] = [];
    const { session } = fakeSession({
      onEvent: (event) => events.push(event),
      stream: [
        { type: "system", subtype: "init", session_id: "child-session" },
        { type: "rate_limit_event" },
        { type: "stream_event" },
        { type: "result", is_error: false },
      ],
    });
    await session.start();
    await session.send("hello");
    expect(events).toEqual([{ type: "complete" }]);
  });

  it("runs queued prompts in call order and recovers after a failed turn", async () => {
    const order: string[] = [];
    const firstTurn = deferred<void>();
    const events: ChatEvent[] = [];
    const { session, sdk } = fakeSession({
      onEvent: (event) => events.push(event),
      startTurn: async (turn) => {
        order.push(turn.prompt);
        if (turn.prompt === "first") await firstTurn.promise;
        if (turn.prompt === "bad") throw new Error(`denied at ${CWD}`);
        return immediateRun([
          { type: "system", subtype: "init", session_id: "child-session" },
          { type: "result", is_error: false, session_id: "child-session" },
        ]);
      },
    });
    await session.start();
    const first = session.send("first");
    const second = session.send("second");
    await vi.waitFor(() => expect(order).toEqual(["first"]));
    firstTurn.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);

    await expect(session.send("bad")).rejects.toThrow(`denied at ${CWD}`);
    await session.send("good");
    expect(order).toEqual(["first", "second", "bad", "good"]);
    expect(events.filter((event) => event.type === "error")).toEqual([
      { type: "error", error: { code: "chat_error", message: "denied at [workspace]" } },
    ]);
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual([
      "first",
      "second",
      "bad",
      "good",
    ]);
  });

  it("emits one redacted chat_error and rejects send when the iterator fails", async () => {
    const events: ChatEvent[] = [];
    const { session } = fakeSession({
      onEvent: (event) => events.push(event),
      startTurn: async () => immediateRun(
        [textDelta(`See ${CWD}/result.md`)],
        new Error(`stream died at ${CWD}`),
      ),
    });
    await session.start();
    await expect(session.send("hello")).rejects.toThrow(`stream died at ${CWD}`);
    expect(events).toEqual([
      { type: "chunk", text: "See [workspace]/result.md" },
      { type: "error", error: { code: "chat_error", message: "stream died at [workspace]" } },
    ]);
  });

  it("emits one redacted chat_error and rejects send when onEvent throws", async () => {
    const events: ChatEvent[] = [];
    const { session } = fakeSession({
      onEvent: (event) => {
        events.push(event);
        if (event.type === "chunk") throw new Error(`listener failed at ${CWD}`);
      },
      stream: [textDelta("hi"), { type: "result", is_error: false }],
    });
    await session.start();
    await expect(session.send("hello")).rejects.toThrow(`listener failed at ${CWD}`);
    expect(events).toEqual([
      { type: "chunk", text: "hi" },
      { type: "error", error: { code: "chat_error", message: "listener failed at [workspace]" } },
    ]);
  });

  it("suppresses a disposal-induced turn failure and disposes the SDK once", async () => {
    const events: ChatEvent[] = [];
    const hanging = hangingRun({ throwOnClose: true });
    const { session, sdk } = fakeSession({
      onEvent: (event) => events.push(event),
      startTurn: async () => hanging,
    });
    await session.start();
    const sending = session.send("hello");
    await hanging.started;
    await session.dispose();
    await expect(sending).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(sdk.dispose).toHaveBeenCalledOnce();
    await session.dispose();
    expect(sdk.dispose).toHaveBeenCalledOnce();
  });

  it("keeps public start and send error strings and does not emit for them", async () => {
    const events: ChatEvent[] = [];
    const { session } = fakeSession({ onEvent: (event) => events.push(event) });
    await expect(session.send("hello")).rejects.toThrow("Session not started");
    await session.start();
    await expect(session.send("")).rejects.toThrow("Message required");
    await expect(session.send("   \n\t")).rejects.toThrow("Message required");
    await session.dispose();
    await expect(session.send("hello")).rejects.toThrow("Session disposed");
    await expect(session.start()).rejects.toThrow("Session disposed");
    expect(events).toEqual([]);
  });

  it("creates the SDK once across idempotent start and dispose", async () => {
    const { session, sdk } = fakeSession();
    await session.start();
    await session.start();
    expect(sdk.createCalls).toBe(1);
    await session.dispose();
    await session.dispose();
    expect(sdk.dispose).toHaveBeenCalledOnce();
    await expect(session.send("hello")).rejects.toThrow(/disposed/i);
  });

  it("defines the fixed provider contract in one server constant", () => {
    // 별칭 그대로다. 구체 id로 고정하면 sonnet 세대가 바뀌어도 펫만 옛 모델에 남는다.
    expect(SCUTTLEBUTT_AGENT).toEqual({ model: "sonnet", effort: "low" });
  });

  it("defines three distinct admiral identities over the shared safety contract", () => {
    const { tori, bori, dori } = ADMIRAL_SYSTEM_PROMPTS;
    expect(tori).toContain("Aide Tori");
    expect(tori).toContain("speak of yourself as he");
    expect(bori).toContain("Aide Bori");
    expect(bori).toContain("speak of yourself as she");
    expect(dori).toContain("Aide Dori");
    expect(dori).toContain("speak of yourself as she");
    expect(new Set([tori, bori, dori])).toHaveLength(3);
    for (const prompt of [tori, bori, dori]) {
      expect(prompt).toContain("# Who you are talking to");
      expect(prompt).toContain("Admiral of the Navy");
      // 부관은 새들 자신의 계급이라, 사용자를 그렇게 부르면 상하가 사라진다. 제독은 이제
      // 호스트 에이전트 한 곳만 가리키므로 이 문장에서 빠졌다.
      expect(prompt).toContain("call them 대원수");
      expect(prompt).toContain("부관, which is your own rank");
      expect(prompt).toContain("Never read, write, edit, list, or execute anything on this machine");
      expect(prompt).toContain("file and shell work belongs to an Operation in a Theater");
      expect(prompt).toContain("Answer in the language the user wrote in.");
      // 자기 소속 제품을 물으면 밀어내지 말고 공개 저장소를 찾아보게 한다.
      expect(prompt).toContain("https://github.com/sbluemin/fleet-harness");
      expect(prompt).toContain("is not reading this machine");
      expect(prompt).toContain("Start at the README and stop as soon as it answers");
      expect(prompt).toContain("Speed is part of the job.");
    }
  });
});

describe("toChatEvents", () => {
  const identity = (value: string): string => value;

  it("streams assistant text and drops thinking from the same delta channel", () => {
    expect(toChatEvents({ kind: "text", text: "hi" }, identity)).toEqual([{ type: "chunk", text: "hi" }]);
    expect(toChatEvents({ kind: "thinking", text: "hmm" }, identity)).toEqual([]);
  });

  it("maps a tool start through the existing title rule", () => {
    expect(toChatEvents({
      kind: "tool-start",
      id: "t1",
      name: "WebSearch",
      input: { query: "fleet console" },
    }, identity)).toEqual([{ type: "tool", title: "WebSearch: fleet console", status: "running" }]);
  });

  it("maps a tool end using the name the common decoder correlated", () => {
    expect(toChatEvents({
      kind: "tool-end",
      id: "t1",
      name: "WebSearch",
      isError: false,
    }, identity)).toEqual([{ type: "tool", title: "WebSearch", status: "done" }]);
  });

  it("falls a missing tool-end name back to tool and marks a failed result", () => {
    expect(toChatEvents({ kind: "tool-end", isError: true }, identity)).toEqual([
      { type: "tool", title: "tool", status: "error" },
    ]);
  });

  it("completes a successful result and uses the exact failure fallback", () => {
    expect(toChatEvents({ kind: "result", isError: false, source: "message" }, identity)).toEqual([
      { type: "complete" },
    ]);
    expect(toChatEvents({ kind: "result", isError: true, source: "message" }, identity)).toEqual([
      { type: "error", error: { code: "chat_error", message: "Chat turn failed" } },
    ]);
    expect(toChatEvents({ kind: "result", isError: true, detail: `denied at ${CWD}`, source: "message" }, identity))
      .toEqual([{ type: "error", error: { code: "chat_error", message: `denied at ${CWD}` } }]);
  });

  it("maps synthetic failed results through the same fallback", () => {
    for (const event of [
      { kind: "result", isError: true, source: "incomplete" },
      { kind: "result", isError: true, source: "watchdog" },
    ] satisfies ClaudeExecutionEvent[]) {
      expect(toChatEvents(event, identity)).toEqual([
        { type: "error", error: { code: "chat_error", message: "Chat turn failed" } },
      ]);
    }
  });
});

function textDelta(text: string): ClaudeGatewayMessage {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } };
}

function thinkingDelta(thinking: string): ClaudeGatewayMessage {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } } };
}

function fakeSession(overrides: {
  admiral?: "tori" | "bori" | "dori";
  onEvent?: (event: ChatEvent) => void;
  stream?: readonly ClaudeGatewayMessage[];
  startTurn?: (turn: ClaudeGatewayTurn) => Promise<ClaudeGatewayRun>;
} = {}): { session: ChatSession; sdk: FakeSdk } {
  const stream = overrides.stream ?? [
    { type: "system", subtype: "init", session_id: "child-session" },
    { type: "result", subtype: "success", is_error: false, session_id: "child-session" },
  ];
  const sdk = new FakeSdk(overrides.startTurn ?? (async () => immediateRun(stream)));
  const session = new ChatSession({
    cwd: CWD,
    admiral: overrides.admiral ?? "tori",
    baseUrl: BASE_URL,
    ...(overrides.onEvent ? { onEvent: overrides.onEvent } : {}),
    createSdk: async (args) => sdk.create(args),
  });
  return { session, sdk };
}

class FakeSdk {
  /** 세션이 조립해 넘긴 생성 인자. 관측 대상이므로 지어내지 않는다. */
  createArgs: unknown = null;
  createCalls = 0;
  readonly configDir = "/tmp/fake";
  readonly models = ["sonnet"];
  readonly dispose = vi.fn(async () => undefined);
  readonly startTurn: ReturnType<typeof vi.fn>;

  constructor(startTurn: (turn: ClaudeGatewayTurn) => Promise<ClaudeGatewayRun>) {
    this.startTurn = vi.fn(startTurn);
  }

  create(args: unknown): ClaudeGatewaySdk {
    this.createCalls += 1;
    this.createArgs = args;
    return this as unknown as ClaudeGatewaySdk;
  }
}

function immediateRun(
  messages: readonly ClaudeGatewayMessage[],
  iterateError?: unknown,
): ClaudeGatewayRun {
  return {
    close() {},
    getContextUsage: async () => null,
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
      if (iterateError !== undefined) throw iterateError;
    },
  };
}

function hangingRun(options: { throwOnClose?: boolean } = {}): ClaudeGatewayRun & {
  readonly started: Promise<void>;
} {
  let closed = false;
  const gate = deferred<void>();
  const started = deferred<void>();
  return {
    started: started.promise,
    getContextUsage: async () => null,
    close() {
      closed = true;
      gate.resolve();
    },
    async *[Symbol.asyncIterator]() {
      started.resolve();
      if (!closed) await gate.promise;
      if (options.throwOnClose) throw new Error("run closed");
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
