import { describe, expect, it } from "vitest";

import { createChatSession, type ChatSessionDeps } from "../client/chat-session.js";
import type { ChatStreamEvent } from "../client/sse-client.js";

interface Harness {
  readonly deps: ChatSessionDeps;
  readonly calls: string[];
  readonly streams: string[];
  emit(event: ChatStreamEvent): void;
  closes(): number;
}

function harness(responses: Partial<Record<"start" | "message", () => Response>> = {}): Harness {
  const calls: string[] = [];
  const streams: string[] = [];
  const listeners: ((event: ChatStreamEvent) => void)[] = [];
  let closes = 0;
  return {
    calls,
    streams,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    closes: () => closes,
    deps: {
      fetch: (path) => {
        calls.push(path);
        const kind = path === "chat/start" ? "start" : "message";
        const make = responses[kind];
        if (make) return Promise.resolve(make());
        return Promise.resolve(kind === "start"
          ? Response.json({ chatId: "chat-1" })
          : Response.json({ accepted: true }));
      },
      connect: (chatId, onEvent) => {
        streams.push(chatId);
        listeners.push(onEvent);
        return {
          connected: Promise.resolve(),
          close: () => {
            closes += 1;
          },
        };
      },
    },
  };
}

describe("Scuttlebutt chat session", () => {
  it("clears the draft, records the question, and waits on the stream", async () => {
    const stub = harness();
    const session = createChatSession(stub.deps);
    session.setDraft("who are you?");

    await session.ask("who are you?");

    expect(stub.calls).toEqual(["chat/start", "chat/chat-1/message"]);
    expect(stub.streams).toEqual(["chat-1"]);
    expect(session.snapshot().draft).toBe("");
    expect(session.snapshot().state.entries.map((entry) => entry.text)).toEqual(["who are you?"]);
    expect(session.snapshot().state.phase).toBe("thinking");
  });

  it("finishes the turn from the stream, which outlives any card that opened it", async () => {
    const stub = harness();
    const session = createChatSession(stub.deps);
    const seen: string[] = [];
    session.subscribe(() => seen.push(session.snapshot().state.phase));

    await session.ask("what can you do?");
    stub.emit({ type: "chunk", text: "Plenty." });
    stub.emit({ type: "complete" });

    expect(session.snapshot().state.phase).toBe("ready");
    expect(seen.at(-1)).toBe("ready");
    expect(stub.closes()).toBe(0);
  });

  it("reuses one chat and one stream across turns", async () => {
    const stub = harness();
    const session = createChatSession(stub.deps);

    await session.ask("first");
    stub.emit({ type: "complete" });
    await session.ask("second");

    expect(stub.calls).toEqual(["chat/start", "chat/chat-1/message", "chat/chat-1/message"]);
    expect(stub.streams).toEqual(["chat-1"]);
  });

  it("refuses a second question while one is still in flight", async () => {
    const stub = harness();
    const session = createChatSession(stub.deps);

    await session.ask("first");
    await session.ask("second");

    expect(stub.calls).toEqual(["chat/start", "chat/chat-1/message"]);
    expect(session.snapshot().state.entries).toHaveLength(1);
  });

  it("surfaces a rejected message instead of thinking forever", async () => {
    const stub = harness({
      message: () => Response.json({ error: "session_busy" }, { status: 409 }),
    });
    const session = createChatSession(stub.deps);

    await session.ask("hello");

    expect(session.snapshot().state.phase).toBe("error");
    expect(session.snapshot().state.entries.map((entry) => entry.kind)).toEqual(["user", "error"]);
    expect(session.snapshot().state.entries.at(-1)?.text).toBe("session_busy");
  });

  it("surfaces a refused start and never opens a stream", async () => {
    const stub = harness({
      start: () => Response.json({ error: "session_unavailable" }, { status: 503 }),
    });
    const session = createChatSession(stub.deps);

    await session.ask("hello");

    expect(stub.streams).toEqual([]);
    expect(session.snapshot().state.phase).toBe("error");
    expect(session.snapshot().state.entries.at(-1)?.text).toBe("session_unavailable");
  });

  it("keeps a completed answer that raced the message response", async () => {
    const stub = harness({
      message: () => {
        stub.emit({ type: "chunk", text: "Done." });
        stub.emit({ type: "complete" });
        return Response.json({ accepted: true });
      },
    });
    const session = createChatSession(stub.deps);

    await session.ask("hello");

    expect(session.snapshot().state.phase).toBe("ready");
  });

  it("closes the stream and goes silent once the widget is gone", async () => {
    const stub = harness();
    const session = createChatSession(stub.deps);
    await session.ask("hello");
    let notified = 0;
    session.subscribe(() => notified += 1);

    session.close();
    stub.emit({ type: "complete" });
    await session.ask("ignored");

    expect(stub.closes()).toBe(1);
    expect(notified).toBe(0);
    expect(session.snapshot().state.phase).toBe("thinking");
  });
});
