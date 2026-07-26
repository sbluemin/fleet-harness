import { describe, expect, it, vi } from "vitest";

import type { ChatEvent, ChatSessionLike } from "../server/chat-session.js";
import { MAX_ACTIVE_CHAT_SESSIONS, SessionRegistry } from "../server/session-registry.js";

describe("SessionRegistry", () => {
  it("runs start/message/stop/dispose and finalizes assistant history on complete", async () => {
    const users: string[] = [];
    const assistants: string[] = [];
    const fake = new FakeSession();
    const registry = new SessionRegistry({
      onUserMessage: (_chatId, text) => { users.push(text); },
      onAssistantMessage: (_chatId, text) => { assistants.push(text); },
    });
    expect(await registry.start("chat", (onEvent) => {
      fake.onEvent = onEvent;
      return fake;
    })).toBe("started");
    const events: ChatEvent[] = [];
    registry.subscribe("chat", (event) => events.push(event));

    expect(await registry.message("chat", "question")).toBe("accepted");
    expect(await registry.message("chat", "parallel")).toBe("busy");
    fake.onEvent?.({ type: "chunk", text: "answer" });
    fake.onEvent?.({ type: "complete" });
    await Promise.resolve();

    expect(users).toEqual(["question"]);
    expect(assistants).toEqual(["answer"]);
    expect(events).toEqual([{ type: "chunk", text: "answer" }, { type: "complete" }]);
    expect(await registry.stop("chat")).toBe(true);
    expect(fake.dispose).toHaveBeenCalledOnce();
    await registry.dispose();
  });

  it("evicts the oldest idle session and refuses capacity when all sessions are busy", async () => {
    const registry = new SessionRegistry();
    const sessions: FakeSession[] = [];
    for (let index = 0; index < MAX_ACTIVE_CHAT_SESSIONS; index += 1) {
      const session = new FakeSession();
      sessions.push(session);
      expect(await registry.start(`chat-${index}`, () => session)).toBe("started");
    }
    expect(await registry.start("replacement", () => new FakeSession())).toBe("started");
    expect(sessions[0]?.dispose).toHaveBeenCalledOnce();

    for (let index = 1; index < MAX_ACTIVE_CHAT_SESSIONS; index += 1) {
      expect(await registry.message(`chat-${index}`, "busy")).toBe("accepted");
    }
    expect(await registry.message("replacement", "busy")).toBe("accepted");
    expect(await registry.start("over-capacity", () => new FakeSession())).toBe("capacity");
    await registry.dispose();
  });
});

class FakeSession implements ChatSessionLike {
  onEvent?: (event: ChatEvent) => void;
  readonly start = vi.fn(async () => undefined);
  readonly send = vi.fn(async () => new Promise<void>(() => undefined));
  readonly dispose = vi.fn(async () => undefined);
}
