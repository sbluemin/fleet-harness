import { describe, expect, it, vi } from "vitest";

import type { ClaudeGatewayMessage, ClaudeGatewaySdk, ClaudeGatewayTurn } from "@dotobokuri/core-agent/claude";

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
    // 오늘의 ACP 권한 분류기는 도구 이름 없이 kind와 입력 모양으로 추측했다. 이제는 파일·셸 도구가
    // 아예 존재하지 않는다 — 실측하면 자식의 system/init이 여기 준 목록 그대로를 보고한다.
    const { session, sdk } = fakeSession();
    await session.start();
    await session.send("hello");
    const turn = sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn;
    expect(turn.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(turn.allowedTools).toEqual(["WebSearch", "WebFetch"]);
    // 승인 대기는 헤드리스에서 멈춘 대화와 같다. 미승인 도구는 물어보지 않고 거부한다.
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
    const turn = sdk.startTurn.mock.calls[0]?.[0] as ClaudeGatewayTurn;
    expect(turn.model).toBe("sonnet");
    expect(turn.effort).toBe("low");
    expect(turn.cwd).toBe(CWD);
    expect(turn.systemPrompt).toEqual({ mode: "replace", text: ADMIRAL_SYSTEM_PROMPTS.bori });
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

  it("disposes the SDK instance and its isolated directory", async () => {
    const { session, sdk } = fakeSession();
    await session.start();
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
    expect(tori).toContain("Admiral Tori");
    expect(tori).toContain("speak of yourself as he");
    expect(bori).toContain("Admiral Bori");
    expect(bori).toContain("speak of yourself as she");
    expect(dori).toContain("Admiral Dori");
    expect(dori).toContain("speak of yourself as she");
    expect(new Set([tori, bori, dori])).toHaveLength(3);
    for (const prompt of [tori, bori, dori]) {
      expect(prompt).toContain("# Who you are talking to");
      expect(prompt).toContain("Admiral of the Navy");
      // 제독은 새들 자신의 계급이라, 사용자를 그렇게 부르면 상하가 사라진다.
      expect(prompt).toContain("call them 대원수");
      expect(prompt).toContain("제독, which is your own rank");
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
    // 두 종류가 같은 자리로 온다. 생각까지 흘리면 펫이 혼잣말을 소리내어 하게 된다.
    expect(toChatEvents(textDelta("hi"), new Map(), identity)).toEqual([{ type: "chunk", text: "hi" }]);
    expect(toChatEvents(thinkingDelta("hmm"), new Map(), identity)).toEqual([]);
  });

  it("pairs a tool call with its result through the id the start block carries", () => {
    const names = new Map<string, string>();
    const started = toChatEvents({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { query: "fleet console" } }] },
    }, names, identity);
    expect(started).toEqual([{ type: "tool", title: "WebSearch: fleet console", status: "running" }]);

    const finished = toChatEvents({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] },
    }, names, identity);
    expect(finished).toEqual([{ type: "tool", title: "WebSearch", status: "done" }]);
  });

  it("marks a failed tool result rather than reporting it as done", () => {
    const names = new Map([["t1", "WebFetch"]]);
    expect(toChatEvents({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] },
    }, names, identity)).toEqual([{ type: "tool", title: "WebFetch", status: "error" }]);
  });

  it("ignores the message kinds the SSE contract has no event for", () => {
    for (const type of ["system", "rate_limit_event", "stream_event"]) {
      expect(toChatEvents({ type }, new Map(), identity)).toEqual([]);
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
} = {}): { session: ChatSession; sdk: FakeSdk } {
  const stream = overrides.stream ?? [
    { type: "system", subtype: "init", session_id: "child-session" },
    { type: "result", subtype: "success", is_error: false, session_id: "child-session" },
  ];
  const sdk = new FakeSdk(stream);
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
  readonly configDir = "/tmp/fake";
  readonly models = ["sonnet"];
  readonly dispose = vi.fn(async () => undefined);
  readonly startTurn: ReturnType<typeof vi.fn>;

  constructor(stream: readonly ClaudeGatewayMessage[]) {
    this.startTurn = vi.fn(async (_turn: ClaudeGatewayTurn) => ({
      [Symbol.asyncIterator]: async function* () {
        for (const message of stream) yield message;
      },
      close: () => {},
    }));
  }

  create(args: unknown): ClaudeGatewaySdk {
    this.createArgs = args;
    return this as unknown as ClaudeGatewaySdk;
  }
}
