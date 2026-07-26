import { describe, expect, it } from "vitest";

import { redactScratchPath } from "../server/chat-session.js";
import { HistoryStore, MAX_THREADS, sanitizeThreads } from "../server/history-store.js";

describe("HistoryStore", () => {
  it("persists only the browser-safe DTO and caps recent threads at 20", async () => {
    const writes: unknown[] = [];
    let value: unknown = [];
    const dataDir = "/private/fleet/plugins/scuttlebutt";
    const store = new HistoryStore({
      readJson: async () => value,
      writeJson: async (_pluginId, _key, next) => {
        value = next;
        writes.push(next);
      },
    }, (text) => redactScratchPath(text, dataDir));

    for (let index = 0; index < MAX_THREADS + 2; index += 1) {
      await store.create({
        id: `chat-${index}`,
        cliId: "claude",
        model: "opus[1m]",
        createdAt: index,
      });
    }
    await store.appendMessage("chat-21", "user", `Find current Fleet news without reading ${dataDir}/workspace`, 30);
    await store.appendMessage("chat-21", "assistant", "A concise answer.", 31);

    const serialized = JSON.stringify(writes.at(-1));
    expect((await store.list())).toHaveLength(MAX_THREADS);
    expect(serialized).not.toContain("providerSession");
    expect(serialized).not.toContain("sessionId");
    expect(serialized).not.toContain(dataDir);
    expect(serialized).toContain("Find current Fleet news");
  });

  it("drops unknown persisted fields instead of reflecting them to the browser", () => {
    const result = sanitizeThreads([{
      id: "chat",
      title: "Safe",
      cliId: "codex",
      model: "gpt",
      createdAt: 1,
      providerSession: { id: "secret" },
      messages: [{
        id: "message",
        role: "assistant",
        text: "safe",
        at: 2,
        sessionId: "secret",
      }],
    }]);
    expect(result).toEqual([{
      id: "chat",
      title: "Safe",
      cliId: "codex",
      model: "gpt",
      createdAt: 1,
      messages: [{ id: "message", role: "assistant", text: "safe", at: 2 }],
    }]);
  });
});
