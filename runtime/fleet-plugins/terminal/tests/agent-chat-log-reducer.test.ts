import { describe, expect, it } from "vitest";

import {
  groupAgentChatLedger,
  initialAgentChatLogState,
  reduceAgentChatLog,
  splitAgentChatTurn,
  type AgentChatLogState,
  type AgentChatStreamEvent,
  type AgentChatTurnItem,
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
    // 현재 작업 여부의 권위는 호스트의 런타임 축으로 옮겼다 — 저널은 턴의 시간축만 소유한다.
    let state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "turn-start" },
      { kind: "text", text: "working on it" },
    ]);
    expect(state.turns.at(-1)?.state).toBe("working");

    state = fold([
      { kind: "turn-end", ok: true, durationMs: 3200 },
    ], state);
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

// 스텝의 생애 — 이름만 아는 시점, 좌표가 채워지는 시점, 결말이 붙는 시점.
describe("chat log steps", () => {
  it("fills the step tool-start opened instead of adding a second row", () => {
    let state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "turn-start" },
      { kind: "tool-start", id: "t1", name: "Write" },
    ]);
    expect(state.turns.at(-1)?.items).toEqual([
      { type: "tool", name: "Write", detail: "", id: "t1", state: "running" },
    ]);

    state = fold([{ kind: "tool", name: "Write", detail: "todo.py", id: "t1" }], state);
    expect(state.turns.at(-1)?.items).toEqual([
      { type: "tool", name: "Write", detail: "todo.py", id: "t1", state: "running" },
    ]);

    state = fold([{ kind: "tool-result", id: "t1", ok: true, summary: "File created" }], state);
    expect(state.turns.at(-1)?.items.at(-1)).toMatchObject({ state: "ok", result: "File created" });
  });

  it("settles a still-running step when the turn closes without its result", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "turn-start" },
      { kind: "tool-start", id: "t1", name: "Bash" },
      { kind: "turn-end", ok: true },
    ]);
    // 결과를 못 받은 스텝은 성공(✓ ok)이 아니라 중립(done)으로 가라앉는다.
    expect(state.turns.at(-1)?.items.at(-1)).toMatchObject({ state: "done" });
  });

  it("drops a result whose step is not in the log", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "tool-result", id: "orphan", ok: false, summary: "nope" },
    ]);
    expect(state.turns.at(-1)?.items).toEqual([]);
  });
});

// 원장 집계 — 일상은 세고, 예외만 줄을 지킨다.
describe("groupAgentChatLedger", () => {
  const tool = (name: string, extra: Partial<AgentChatTurnItem> = {}): AgentChatTurnItem =>
    ({ type: "tool", name, detail: "", state: "ok", ...extra });

  it("folds routine finished steps into one count per family", () => {
    const view = groupAgentChatLedger([
      tool("Read"), tool("NotebookRead"), tool("Write"), tool("Edit"), tool("Bash"), tool("Bash"),
    ]);
    expect(view.groups).toEqual([
      { family: "read", count: 2 },
      { family: "write", count: 1 },
      { family: "edit", count: 1 },
      { family: "run", count: 2 },
    ]);
    expect(view.inline).toEqual([]);
    expect(view.running).toEqual([]);
  });

  it("keeps the running step, the failure and the outside write on their own rows", () => {
    const failed = tool("Bash", { state: "fail", result: "exit 2" });
    const outside = tool("Write", { outside: true, detail: "…/elsewhere/a.ts" });
    const live = tool("Read", { state: "running" });
    const note: AgentChatTurnItem = { type: "text", text: "먼저 읽겠습니다." };
    const view = groupAgentChatLedger([note, tool("Read"), failed, outside, tool("Read"), live]);
    expect(view.inline).toEqual([note, failed, outside]);
    expect(view.groups).toEqual([{ family: "read", count: 2 }]);
    expect(view.running).toEqual([live]);
  });

  // 진행 중에는 방금 무엇을 했는지가 보여야 한다 — 끝난 스텝이 곧바로 사라지면 화면에
  // 남는 것은 집계 한 줄과 "생각 중"뿐이고, 그건 일하는 화면이 아니다.
  it("keeps the most recent finished steps in order while the turn runs", () => {
    const items = [tool("Read"), tool("Read"), tool("Bash"), tool("Write")];
    const live = groupAgentChatLedger(items, 2);
    expect(live.inline).toEqual([items[2], items[3]]);
    expect(live.groups).toEqual([{ family: "read", count: 2 }]);
  });

  it("folds every routine step once the turn is done", () => {
    const items = [tool("Read"), tool("Read"), tool("Bash"), tool("Write")];
    const settled = groupAgentChatLedger(items, 0);
    expect(settled.inline).toEqual([]);
    expect(settled.groups).toEqual([
      { family: "read", count: 2 },
      { family: "run", count: 1 },
      { family: "write", count: 1 },
    ]);
  });

  it("counts an unknown tool under its own name", () => {
    const view = groupAgentChatLedger([tool("SomeMcpTool"), tool("SomeMcpTool"), tool("Other")]);
    expect(view.groups).toEqual([
      { family: "other", name: "SomeMcpTool", count: 2 },
      { family: "other", name: "Other", count: 1 },
    ]);
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
    // 재생 스텝은 이미 끝난 일이다 — 결과 줄이 없으면 성공을 주장하지 않는 done으로 앉는다.
    expect(view.ledger).toEqual([
      { type: "tool", name: "Read", detail: "a.ts", state: "done" },
      { type: "text", text: "intermediate note" },
      { type: "tool", name: "Bash", detail: "pnpm test", state: "done" },
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
    expect(view.ledger).toEqual([{ type: "tool", name: "Read", detail: "a.ts", state: "done" }]);
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
    expect(view.ledger).toEqual([{ type: "tool", name: "Read", detail: "a.ts", state: "running" }]);
    expect(view.answer).toBeNull();
  });

  it("counts failed steps and folds same-file changes into one ledger entry", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "tool", name: "Write", detail: "a.ts", id: "t1", change: { file: "a.ts", added: 10, removed: 0 } },
      { kind: "tool-result", id: "t1", ok: true, summary: "File created" },
      { kind: "tool", name: "Edit", detail: "a.ts", id: "t2", change: { file: "a.ts", added: 3, removed: 1 } },
      { kind: "tool-result", id: "t2", ok: true, summary: "" },
      { kind: "tool", name: "Bash", detail: "pnpm test", id: "t3" },
      { kind: "tool-result", id: "t3", ok: false, summary: "1 test failed" },
      { kind: "turn-end", ok: true, durationMs: 4200 },
    ]);
    const view = splitAgentChatTurn(state.turns.at(-1)!);
    expect(view.failed).toBe(1);
    expect(view.changes).toEqual([{ file: "a.ts", added: 13, removed: 1 }]);
    expect(view.ledger.at(-1)).toMatchObject({ name: "Bash", state: "fail", result: "1 test failed" });
  });

  it("keeps a failed write out of the change ledger", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "tool", name: "Write", detail: "a.ts", id: "t1", change: { file: "a.ts", added: 10, removed: 0 } },
      { kind: "tool-result", id: "t1", ok: false, summary: "EACCES" },
      { kind: "turn-end", ok: true },
    ]);
    const view = splitAgentChatTurn(state.turns.at(-1)!);
    expect(view.changes).toEqual([]);
    expect(view.failed).toBe(1);
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
