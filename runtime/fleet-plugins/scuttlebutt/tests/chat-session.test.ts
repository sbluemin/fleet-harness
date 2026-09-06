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
