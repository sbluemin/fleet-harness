import { describe, expect, it } from "vitest";

import { initialChatState, reduceChatEvent } from "../client/chat-store.js";

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
