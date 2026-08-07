import { describe, expect, it } from "vitest";

import { createSseFrameParser, interpretAgentSessionFrame } from "../../fleet-plugins/terminal/client/agent/sse.js";

describe("createSseFrameParser", () => {
  it("yields frames split across chunk boundaries", () => {
    const parse = createSseFrameParser();
    expect(parse("event: message\ndata: {\"a\":")).toEqual([]);
    const frames = parse("1}\n\nevent: observer:truncated\ndata: {}\n\n");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ event: "message", data: '{"a":1}' });
    expect(frames[1]).toEqual({ event: "observer:truncated", data: "{}" });
  });

  it("joins multi-line data fields", () => {
    const parse = createSseFrameParser();
    const frames = parse("data: line1\ndata: line2\n\n");
    expect(frames[0]?.data).toBe("line1\nline2");
  });

  it("ignores keepalive comments", () => {
    const parse = createSseFrameParser();
    expect(parse(": keepalive\n\n")).toEqual([]);
  });
});

describe("interpretAgentSessionFrame", () => {

  it("reads terminal session update frames", () => {
    const frame = interpretAgentSessionFrame({
      event: "session:updated",
      data: JSON.stringify({
        session: {
          sessionId: "session-a",
          terminalSessionId: "session-a",
          cwdLabel: "alpha",
          label: "Bridge",
          status: "terminal-only",
          createdAt: 1_000,
        },
      }),
    });

    expect(frame).toMatchObject({ kind: "session", session: { sessionId: "session-a", label: "Bridge" } });
  });

  it("reads terminal session attention frames as a transient attention kind", () => {
    const frame = interpretAgentSessionFrame({
      event: "session:attention",
      data: JSON.stringify({
        session: {
          sessionId: "session-a",
          terminalSessionId: "session-a",
          cwdLabel: "alpha",
          label: "Bridge",
          status: "registered",
          createdAt: 1_000,
        },
      }),
    });

    expect(frame).toMatchObject({ kind: "attention", session: { sessionId: "session-a", label: "Bridge" } });
  });

  it("carries a known attention reason through the attention frame", () => {
    const frame = interpretAgentSessionFrame({
      event: "session:attention",
      data: JSON.stringify({
        reason: "idle_prompt",
        session: {
          sessionId: "session-a",
          terminalSessionId: "session-a",
          cwdLabel: "alpha",
          label: "Bridge",
          status: "registered",
          createdAt: 1_000,
        },
      }),
    });

    expect(frame).toMatchObject({ kind: "attention", reason: "idle_prompt", session: { sessionId: "session-a" } });
  });

  it("drops an unknown attention reason to undefined", () => {
    const frame = interpretAgentSessionFrame({
      event: "session:attention",
      data: JSON.stringify({
        reason: "totally-bogus",
        session: {
          sessionId: "session-a",
          terminalSessionId: "session-a",
          cwdLabel: "alpha",
          label: "Bridge",
          status: "registered",
          createdAt: 1_000,
        },
      }),
    });

    expect(frame).toMatchObject({ kind: "attention" });
    expect(frame?.reason).toBeUndefined();
  });

  it("returns null for malformed payloads", () => {
    expect(interpretAgentSessionFrame({ event: "session:updated", data: "not-json" })).toBeNull();
    expect(interpretAgentSessionFrame({ event: "session:updated", data: "{}" })).toBeNull();
    // 퇴역한 캐리어 관측 프레임은 더 이상 해석되지 않는다.
    expect(interpretAgentSessionFrame({ event: "observer:truncated", data: JSON.stringify({ truncation: { droppedCount: 12 } }) })).toBeNull();
  });
});
