import { describe, expect, it } from "vitest";

import {
  initialAgentChatLogState,
  reduceAgentChatLog,
  splitAgentChatTurn,
  type AgentChatLogState,
  type AgentChatStreamEvent,
} from "../client/agent/chat/chat-events.js";

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

  // 델타는 draft 버퍼에 쌓이고, 완성 text 이벤트가 도착하면 버퍼를 비우고 확정 아이템으로
  // 치환한다 — 완성 메시지가 델타 유실의 정정 앵커다.
  it("accumulates deltas into the draft and settles them with the merged text", () => {
    let state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "turn-start", at: 1755130000000 },
      { kind: "text-delta", text: "Hel" },
      { kind: "text-delta", text: "lo." },
    ]);
    expect(state.turns.at(-1)).toMatchObject({ draft: "Hello.", items: [], startedAt: 1755130000000 });
    expect(splitAgentChatTurn(state.turns.at(-1)!).streamingText).toBe("Hello.");

    state = fold([{ kind: "text", text: "Hello there." }], state);
    expect(state.turns.at(-1)).toMatchObject({ draft: "", items: [{ type: "text", text: "Hello there." }] });
    expect(splitAgentChatTurn(state.turns.at(-1)!).streamingText).toBe("Hello there.");
  });

  // 델타 개별은 서버 캡 안이어도 누적은 무제한이 될 수 있다 — draft는 확정 text와 같은
  // 60k 상한에서 성장을 멈춘다.
  it("caps the accumulated draft at the shared text limit", () => {
    let state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "turn-start" },
      { kind: "text-delta", text: "x".repeat(59_999) },
    ]);
    state = fold([
      { kind: "text-delta", text: "y".repeat(10_000) },
      { kind: "text-delta", text: "z".repeat(10_000) },
    ], state);
    expect(state.turns.at(-1)?.draft).toHaveLength(60_000);
    expect(state.turns.at(-1)?.draft.endsWith("y")).toBe(true);
  });

  it("recovers an unsettled draft into an item when the turn ends early", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "turn-start" },
      { kind: "text-delta", text: "partial ans" },
      { kind: "turn-end", ok: true },
    ]);
    expect(state.turns.at(-1)).toMatchObject({ draft: "", state: "done" });
    expect(state.turns.at(-1)?.items).toEqual([{ type: "text", text: "partial ans" }]);
  });

  it("stores the server answer carried on turn-end", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "text", text: "Final." },
      { kind: "turn-end", ok: true, durationMs: 10, answer: "Final." },
    ]);
    expect(state.turns.at(-1)).toMatchObject({ state: "done", answer: "Final." });
  });
});

// 뷰 파생 — 원장(과정)과 Answer(결론)의 분리 규칙을 못 박는다.
describe("splitAgentChatTurn", () => {
  it("promotes the trailing text of a settled turn to the answer", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "dispatch", text: "ask" },
      { kind: "tool", name: "Read", detail: "a.ts" },
      { kind: "text", text: "intermediate note" },
      { kind: "tool", name: "Bash", detail: "pnpm test" },
      { kind: "text", text: "The final answer." },
      { kind: "replay-end", turns: 1 },
    ]);
    const view = splitAgentChatTurn(state.turns[0]!);
    expect(view.answer).toBe("The final answer.");
    expect(view.ledger).toEqual([
      { type: "tool", name: "Read", detail: "a.ts" },
      { type: "text", text: "intermediate note" },
      { type: "tool", name: "Bash", detail: "pnpm test" },
    ]);
    expect(view.streamingText).toBeNull();
  });

  it("prefers the server answer and dedupes an identical trailing text", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "tool", name: "Read", detail: "a.ts" },
      { kind: "text", text: "Final answer.\n" },
      { kind: "turn-end", ok: true, answer: "Final answer." },
    ]);
    const view = splitAgentChatTurn(state.turns.at(-1)!);
    expect(view.answer).toBe("Final answer.");
    expect(view.ledger).toEqual([{ type: "tool", name: "Read", detail: "a.ts" }]);
  });

  it("keeps a diverging trailing text in the ledger next to the server answer", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "text", text: "something else entirely" },
      { kind: "turn-end", ok: true, answer: "Final answer." },
    ]);
    const view = splitAgentChatTurn(state.turns.at(-1)!);
    expect(view.answer).toBe("Final answer.");
    expect(view.ledger).toEqual([{ type: "text", text: "something else entirely" }]);
  });

  it("keeps a working turn's trailing text out of the ledger while it streams", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "tool", name: "Read", detail: "a.ts" },
      { kind: "text", text: "So far " },
      { kind: "text-delta", text: "so good" },
    ]);
    const view = splitAgentChatTurn(state.turns.at(-1)!);
    expect(view.streamingText).toBe("So far so good");
    expect(view.ledger).toEqual([{ type: "tool", name: "Read", detail: "a.ts" }]);
    expect(view.answer).toBeNull();
  });

  it("never promotes an answer for an error turn", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "text", text: "partial" },
      { kind: "turn-end", ok: false },
    ]);
    const view = splitAgentChatTurn(state.turns.at(-1)!);
    expect(view.answer).toBeNull();
    expect(view.ledger).toEqual([{ type: "text", text: "partial" }]);
  });
});
