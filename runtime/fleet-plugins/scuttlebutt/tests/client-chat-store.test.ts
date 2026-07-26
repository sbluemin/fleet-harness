import { describe, expect, it } from "vitest";

import {
  appendUser,
  currentExchange,
  hydrateEntries,
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
    const hydrated = hydrateEntries([{
      id: "thread",
      title: "Earlier",
      cliId: "claude",
      model: "haiku",
      createdAt: 0,
      messages: [
        { id: "m1", role: "user", text: "First question", at: 1 },
        { id: "m2", role: "assistant", text: "First answer", at: 2 },
        { id: "m3", role: "user", text: "Second question", at: 3 },
        { id: "m4", role: "assistant", text: "Second answer", at: 4 },
      ],
    }]);

    const visible = currentExchange(hydrated);

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
