import { describe, expect, it } from "vitest";

import {
  appendUser,
  currentExchange,
  initialChatState,
  reduceChatEvent,
} from "../client/chat-store.js";

describe("Scuttlebutt chat SSE reducer", () => {
  it("accumulates successive chunks into one assistant entry", () => {
    const first = reduceChatEvent(initialChatState, { type: "chunk", text: "Hello " });
    const second = reduceChatEvent(first, { type: "chunk", text: "**fleet**" });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({ kind: "assistant", text: "Hello **fleet**" });
    expect(second.phase).toBe("thinking");
  });

  it("maps tools to quiet status and completes the turn", () => {
    const tool = reduceChatEvent(initialChatState, {
      type: "tool",
      title: "WebSearch",
      status: "running",
    });
    expect(tool.entries[0]).toMatchObject({ kind: "tool", text: "Searching…" });
    expect(reduceChatEvent(tool, { type: "complete" }).phase).toBe("ready");
  });

  it("localizes quiet tool statuses", () => {
    const reading = reduceChatEvent(initialChatState, {
      type: "tool",
      title: "Read",
      status: "running",
    }, "ko");
    expect(reading.entries[0]).toMatchObject({ kind: "tool", text: "출처를 읽는 중…" });
  });

  it("retains a quiet error entry", () => {
    const failed = reduceChatEvent(initialChatState, {
      type: "error",
      error: { code: "chat_error", message: "Search failed." },
    });
    expect(failed.entries[0]).toMatchObject({ kind: "error", text: "Search failed." });
    expect(failed.phase).toBe("error");
  });
});

describe("Scuttlebutt current exchange", () => {
  it("keeps only the latest question and what followed it", () => {
    const firstQuestion = appendUser(initialChatState, "First question");
    const firstAnswer = reduceChatEvent(firstQuestion, { type: "chunk", text: "First answer" });
    const secondQuestion = appendUser(firstAnswer, "Second question");
    const secondAnswer = reduceChatEvent(secondQuestion, { type: "chunk", text: "Second answer" });
    const visible = currentExchange(secondAnswer);

    expect(visible.map((entry) => entry.text)).toEqual(["Second question", "Second answer"]);
    expect(visible.some((entry) => entry.text === "First question")).toBe(false);
  });

  it("drops the previous exchange as soon as a new question is asked", () => {
    const answered = reduceChatEvent(
      appendUser(initialChatState, "Old question"),
      { type: "chunk", text: "Old answer" },
    );
    const asked = appendUser(answered, "New question");

    expect(currentExchange(asked).map((entry) => entry.text)).toEqual(["New question"]);
  });

  it("still surfaces an error raised before any question", () => {
    const failed = reduceChatEvent(initialChatState, {
      type: "error",
      error: { code: "client_error", message: "Chat is unavailable." },
    });

    expect(currentExchange(failed)).toHaveLength(1);
  });
});
