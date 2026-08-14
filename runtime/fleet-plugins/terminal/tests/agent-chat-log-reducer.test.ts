import { describe, expect, it } from "vitest";

import { initialAgentChatLogState, reduceAgentChatLog, type AgentChatLogState, type AgentChatStreamEvent } from "../client/agent/chat/chat-events.js";

function fold(events: readonly AgentChatStreamEvent[], from: AgentChatLogState = initialAgentChatLogState): AgentChatLogState {
  return events.reduce(reduceAgentChatLog, from);
}

describe("chat log reducer", () => {
  it("groups a replay into settled turns", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "dispatch", text: "first" },
      { kind: "text", text: "answer one" },
      { kind: "tool", name: "Read", detail: "a.ts" },
      { kind: "dispatch", text: "second" },
      { kind: "text", text: "answer two" },
      { kind: "replay-end", turns: 2 },
    ]);
    expect(state.replaying).toBe(false);
    expect(state.replayedTurns).toBe(2);
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]).toMatchObject({ state: "done", toolCount: 1 });
    expect(state.turns[1]).toMatchObject({ state: "done", dispatch: { text: "second" } });
  });

  it("runs a live turn through working to done with duration", () => {
    let state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "turn-start" },
      { kind: "status", working: true },
      { kind: "text", text: "working on it" },
    ]);
    expect(state.working).toBe(true);
    expect(state.turns.at(-1)?.state).toBe("working");

    state = fold([
      { kind: "turn-end", ok: true, durationMs: 3200 },
      { kind: "status", working: false },
    ], state);
    expect(state.working).toBe(false);
    expect(state.turns.at(-1)).toMatchObject({ state: "done", durationMs: 3200 });
  });

  it("marks a failed turn as error without dropping its partial output", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "text", text: "partial" },
      { kind: "error", code: "chat_turn_failed" },
      { kind: "turn-end", ok: false },
    ]);
    expect(state.errorCode).toBe("chat_turn_failed");
    expect(state.turns.at(-1)).toMatchObject({ state: "error" });
    expect(state.turns.at(-1)?.items).toEqual([{ type: "text", text: "partial" }]);
  });

  it("resets cleanly when a reconnect replays the journal again", () => {
    const first = fold([
      { kind: "replay-start" },
      { kind: "dispatch", text: "first" },
      { kind: "replay-end", turns: 1 },
    ]);
    const second = fold([
      { kind: "replay-start" },
      { kind: "dispatch", text: "first" },
      { kind: "replay-end", turns: 1 },
    ], first);
    expect(second.turns).toHaveLength(1);
  });

  it("keeps a truncated replay that starts mid-turn readable", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "text", text: "tail of an earlier answer" },
      { kind: "replay-end", turns: 0 },
    ]);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({ dispatch: null, state: "done" });
  });
});
