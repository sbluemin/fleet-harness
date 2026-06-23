import { describe, expect, it } from "vitest";

import { createSseFrameParser, interpretObserverFrame } from "../../fleet-plugins/terminal/client/agent/sse.js";

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

describe("interpretObserverFrame", () => {
  const observed = { id: 7, tenantId: "tenant-1", jobId: "job-1", type: "track:text", at: 1_000, event: { type: "track:text" } };

  it("reads aggregate frames with tenant wrappers", () => {
    const frame = interpretObserverFrame({
      event: "message",
      data: JSON.stringify({ tenant: { tenantId: "tenant-1", tenantLabel: "Alpha" }, event: observed }),
    });
    expect(frame).toMatchObject({ kind: "event", tenantId: "tenant-1", tenantLabel: "Alpha" });
    expect(frame?.event?.id).toBe(7);
  });

  it("reads bare observed events", () => {
    const frame = interpretObserverFrame({ event: "message", data: JSON.stringify(observed) });
    expect(frame).toMatchObject({ kind: "event", tenantId: "tenant-1" });
  });

  it("reads truncation frames", () => {
    const frame = interpretObserverFrame({
      event: "observer:truncated",
      data: JSON.stringify({ tenant: { tenantId: "tenant-1" }, truncation: { droppedCount: 12 } }),
    });
    expect(frame).toMatchObject({ kind: "truncation", truncation: { droppedCount: 12 } });
  });

  it("reads terminal session update frames separately from observed events", () => {
    const frame = interpretObserverFrame({
      event: "session:updated",
      data: JSON.stringify({
        session: {
          sessionId: "session-a",
          terminalSessionId: "session-a",
          cwdLabel: "alpha",
          sequence: 1,
          label: "Bridge",
          status: "terminal-only",
          createdAt: 1_000,
        },
      }),
    });

    expect(frame).toMatchObject({ kind: "session", session: { sessionId: "session-a", label: "Bridge" } });
    expect(frame?.event).toBeUndefined();
  });

  it("reads terminal session attention frames as a transient attention kind", () => {
    const frame = interpretObserverFrame({
      event: "session:attention",
      data: JSON.stringify({
        session: {
          sessionId: "session-a",
          terminalSessionId: "session-a",
          cwdLabel: "alpha",
          sequence: 1,
          label: "Bridge",
          status: "registered",
          createdAt: 1_000,
        },
      }),
    });

    expect(frame).toMatchObject({ kind: "attention", session: { sessionId: "session-a", label: "Bridge" } });
    expect(frame?.event).toBeUndefined();
  });

  it("carries a known attention reason through the attention frame", () => {
    const frame = interpretObserverFrame({
      event: "session:attention",
      data: JSON.stringify({
        reason: "idle_prompt",
        session: {
          sessionId: "session-a",
          terminalSessionId: "session-a",
          cwdLabel: "alpha",
          sequence: 1,
          label: "Bridge",
          status: "registered",
          createdAt: 1_000,
        },
      }),
    });

    expect(frame).toMatchObject({ kind: "attention", reason: "idle_prompt", session: { sessionId: "session-a" } });
  });

  it("drops an unknown attention reason to undefined", () => {
    const frame = interpretObserverFrame({
      event: "session:attention",
      data: JSON.stringify({
        reason: "totally-bogus",
        session: {
          sessionId: "session-a",
          terminalSessionId: "session-a",
          cwdLabel: "alpha",
          sequence: 1,
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
    expect(interpretObserverFrame({ event: "message", data: "not-json" })).toBeNull();
    expect(interpretObserverFrame({ event: "message", data: "{}" })).toBeNull();
  });
});
