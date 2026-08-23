import { describe, expect, it } from "vitest";

import {
  segmentAgentChatLedger,
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
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]).toMatchObject({ state: "done", toolCount: 1 });
    expect(state.turns[1]).toMatchObject({ state: "done", dispatch: { text: "second" } });
  });

  // 트랜스크립트의 주입 운반체(백그라운드 작업 결말 등)는 말풍선 없이 turn-start만 남긴다.
  // 그 경계가 없으면 뒤따르는 응답이 앞 턴에 얹혀 앞 턴의 Answer를 밀어낸다.
  it("opens a settled bubbleless turn for a replayed carrier without swallowing the previous answer", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "dispatch", text: "ship it" },
      { kind: "text", text: "워크플로를 띄웠습니다. 결과를 기다립니다." },
      { kind: "turn-start", at: 1755130000000 },
      { kind: "text", text: "워크플로가 실패했습니다. 원인은 스키마입니다." },
      { kind: "replay-end", turns: 2 },
    ]);
    expect(state.turns).toHaveLength(2);
    // 앞 턴은 자기 Answer를 그대로 지킨다.
    expect(state.turns[0]).toMatchObject({
      state: "done",
      dispatch: { text: "ship it" },
      items: [{ type: "text", text: "워크플로를 띄웠습니다. 결과를 기다립니다." }],
    });
    // 뒤 턴은 사용자 말풍선 없이 서고, 재생이므로 "작업 중"으로 굳지 않는다.
    expect(state.turns[1]).toMatchObject({
      state: "done",
      dispatch: null,
      startedAt: 1755130000000,
      items: [{ type: "text", text: "워크플로가 실패했습니다. 원인은 스키마입니다." }],
    });
  });

  it("keeps a capped journal's dispatch and immediate start in one replayed turn", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "dispatch", text: "queued before reconnect" },
      { kind: "turn-start", at: 1755130000000 },
      { kind: "text", text: "완료했습니다." },
      { kind: "turn-end", ok: true },
      { kind: "replay-end", turns: 1 },
    ]);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({
      state: "done",
      dispatch: { text: "queued before reconnect" },
      startedAt: 1755130000000,
    });
  });

  // 저널이 상한에 걸려 replay-start가 잘려 나가면 재접속한 브라우저는 replaying:false로 시작한다.
  // 그때 남은 저널의 turn-start는 라이브로 읽혀 "작업 중"이 되는데, replay-end가 그 뒤에 오면
  // 그 턴은 지나간 과거임이 확정된다 — 플래그와 무관하게 닫혀야 티커가 굳지 않는다.
  it("settles a turn left working when replay-start was spliced out of the journal", () => {
    const state = fold([
      { kind: "turn-start", at: 1755130000000 },
      { kind: "text", text: "잘린 저널에서 되살아난 응답" },
      { kind: "replay-end", turns: 7 },
    ]);
    expect(state.replaying).toBe(false);
    expect(state.turns.at(-1)).toMatchObject({ state: "done", dispatch: null });
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

// 원장 구간 — 모델의 문장이 구간을 가르고, 각 구간이 자기가 한 일을 한 줄로 접는다.
describe("segmentAgentChatLedger", () => {
  const tool = (name: string, extra: Partial<AgentChatTurnItem> = {}): AgentChatTurnItem =>
    ({ type: "tool", name, detail: "", state: "ok", ...extra });
  const note = (text: string): AgentChatTurnItem => ({ type: "text", text });

  // 턴 전체를 하나로 세면 숫자만 커지고 무엇을 하려던 건지가 사라진다.
  it("splits one turn into a segment per note, each folding only its own steps", () => {
    const items = [
      note("먼저 읽겠습니다."), tool("Read"), tool("Read"),
      note("이제 고치고 돌리겠습니다."), tool("Edit"), tool("Bash"), tool("Bash"),
    ];
    expect(segmentAgentChatLedger(items)).toEqual([
      {
        note: "먼저 읽겠습니다.",
        parts: [{ kind: "tally", groups: [{ family: "read", count: 2 }], folded: [items[1], items[2]] }],
      },
      {
        note: "이제 고치고 돌리겠습니다.",
        parts: [{
          kind: "tally",
          groups: [{ family: "edit", count: 1 }, { family: "run", count: 2 }],
          folded: [items[4], items[5], items[6]],
        }],
      },
    ]);
  });

  it("opens a leading segment when tools arrive before any note", () => {
    const items = [tool("Read"), note("읽었습니다."), tool("Bash")];
    const segments = segmentAgentChatLedger(items);
    expect(segments[0]).toEqual({
      parts: [{ kind: "tally", groups: [{ family: "read", count: 1 }], folded: [items[0]] }],
    });
    expect(segments[1]?.note).toBe("읽었습니다.");
  });

  it("folds the failure and the outside write into the same tally as ordinary steps", () => {
    const read = tool("Read");
    const failed = tool("Bash", { state: "fail", result: "exit 2" });
    const outside = tool("Write", { outside: true, detail: "…/elsewhere/a.ts" });
    const segments = segmentAgentChatLedger([note("해보겠습니다."), read, failed, outside]);
    expect(segments[0]?.parts).toEqual([{
      kind: "tally",
      groups: [
        { family: "read", count: 1 },
        { family: "run", count: 1 },
        { family: "write", count: 1 },
      ],
      folded: [read, failed, outside],
    }]);
  });

  it("counts a failed step in the same family as a successful sibling", () => {
    const ok = tool("Bash", { detail: "pnpm test" });
    const failed = tool("Bash", { state: "fail", result: "exit 2" });
    const segments = segmentAgentChatLedger([note("돌리겠습니다."), ok, failed]);
    expect(segments[0]?.parts).toEqual([{ kind: "tally", groups: [{ family: "run", count: 2 }], folded: [ok, failed] }]);
  });

  // 라이브 창은 없다. 도는 구간도 끝난 구간과 같은 집계 한 줄로 접히고, 지금 도는 스텝만
  // 그 뒤에 줄을 지킨다 — 그 한 줄이 호출부에서 링·물결·도구 이름을 얻어 "일하는 중"을 진다.
  it("folds a running segment the same way as a finished one, leaving only the running step", () => {
    const items = [
      note("먼저 읽겠습니다."), tool("Read"), tool("Read"),
      note("이제 돌리겠습니다."), tool("Bash"), tool("Write"), tool("Read", { state: "running" }),
    ];
    const segments = segmentAgentChatLedger(items);
    expect(segments[0]).toEqual({
      note: "먼저 읽겠습니다.",
      parts: [{ kind: "tally", groups: [{ family: "read", count: 2 }], folded: [items[1], items[2]] }],
    });
    expect(segments[1]?.parts).toEqual([
      { kind: "tally", groups: [{ family: "run", count: 1 }, { family: "write", count: 1 }], folded: [items[4], items[5]] },
      { kind: "step", item: items[6] },
    ]);
  });

  // 결과 없이 닫힌 스텝을 과거형으로 세면, 같은 이유로 변경 장부에서 뺀 쓰기를 원장이
  // 다시 "씀"이라고 말한다 — 두 표면이 어긋난다. 확인되지 않은 것은 줄을 지킨다.
  it("never counts a result-less step in the past-tense tally", () => {
    const unconfirmed = tool("Write", { state: "done" });
    const items = [note("쓰겠습니다."), tool("Read"), unconfirmed];
    const segments = segmentAgentChatLedger(items);
    expect(segments[0]?.parts).toEqual([
      { kind: "tally", groups: [{ family: "read", count: 1 }], folded: [items[1]] },
      { kind: "step", item: unconfirmed },
    ]);
  });

  // 접힌 것은 감춘 것이 아니다 — 집계 줄을 누르면 그 줄이 세고 있던 스텝이 순서대로 나온다.
  it("carries the steps a tally counted so the line can unfold them", () => {
    const items = [note("보겠습니다."), tool("Read"), tool("Bash"), tool("Read")];
    const segment = segmentAgentChatLedger(items)[0];
    expect(segment?.parts).toEqual([{
      kind: "tally",
      groups: [{ family: "read", count: 2 }, { family: "run", count: 1 }],
      folded: [items[1], items[2], items[3]],
    }]);
  });

  it("counts an unknown tool under its own name", () => {
    const segments = segmentAgentChatLedger([tool("SomeMcpTool"), tool("SomeMcpTool"), tool("Other")]);
    expect(segments[0]?.parts[0]).toMatchObject({
      groups: [
        { family: "other", name: "SomeMcpTool", count: 2 },
        { family: "other", name: "Other", count: 1 },
      ],
    });
  });

  // 문장은 마크다운으로 그려지고 그 문법은 공백으로 쓰인다 — 첫 줄의 네 칸은 코드 블록,
  // 줄 끝 두 칸은 줄바꿈이다. 다듬으면 모델이 쓴 형식이 표시 직전에 사라지므로 그대로 넘긴다.
  it("hands the sentence over untouched so its markdown survives", () => {
    const raw = "    const cap = 1_000;\n\n읽겠습니다.  \n계속합니다.\n\n";
    const segments = segmentAgentChatLedger([note(raw), tool("Read")]);
    expect(segments[0]?.note).toBe(raw);
  });

  // 공백만 남은 문장은 구간을 열 자격이 없다 — 그리면 아무것도 말하지 않는 여백만 선다.
  it("drops a segment whose sentence and steps are both empty", () => {
    expect(segmentAgentChatLedger([note("\n \n")])).toEqual([]);
    expect(segmentAgentChatLedger([note("  "), note("고치겠습니다."), tool("Edit")])).toEqual([
      {
        note: "고치겠습니다.",
        parts: [{ kind: "tally", groups: [{ family: "edit", count: 1 }], folded: [expect.anything()] }],
      },
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

  it("marks the failed step and folds same-file changes into one ledger entry", () => {
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
    expect(view.changes).toEqual([{ file: "a.ts", added: 13, removed: 1 }]);
    expect(view.ledger.at(-1)).toMatchObject({ name: "Bash", state: "fail", result: "1 test failed" });
  });

  // 턴이 결과를 못 받고 닫히면 그 쓰기가 실행됐는지 자체를 모른다 — 모르는 것을 "바뀌었다"로
  // 세우면 이 원장이 고치려던 거짓말(✓로 접히던 실패)을 형태만 바꿔 되풀이하는 것이다.
  it("keeps a write that never reported a result out of the change ledger", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "replay-end", turns: 0 },
      { kind: "dispatch", text: "go" },
      { kind: "turn-start" },
      { kind: "tool", name: "Write", detail: "a.ts", id: "t1", change: { file: "a.ts", added: 10, removed: 0 } },
      { kind: "turn-end", ok: false },
    ]);
    const view = splitAgentChatTurn(state.turns.at(-1)!);
    expect(state.turns.at(-1)?.items.at(-1)).toMatchObject({ state: "done" });
    expect(view.changes).toEqual([]);
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
    expect(view.ledger.at(-1)).toMatchObject({ name: "Write", state: "fail", result: "EACCES" });
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

describe("background job ledger", () => {
  it("keeps a job open until a live list or a result says otherwise", () => {
    const state = fold([
      { kind: "job", id: "w1", jobKind: "workflow", title: "two-step", toolUseId: "c1", who: "two-step" },
      { kind: "job-progress", id: "w1", tokens: 1646, tools: 0 },
    ]);
    expect(state.jobs).toEqual([expect.objectContaining({ id: "w1", open: true, tokens: 1646 })]);
    expect(state.jobs[0]?.status).toBeUndefined();
  });

  it("closes a job that left the live list but refuses to call it complete", () => {
    const state = fold([
      { kind: "job", id: "w1", jobKind: "workflow", title: "two-step" },
      { kind: "jobs", ids: [] },
    ]);
    expect(state.jobs[0]).toEqual(expect.objectContaining({ open: false }));
    expect(state.jobs[0]?.status).toBeUndefined();
  });

  it("takes the live list as an absolute value, not a tally", () => {
    const state = fold([
      { kind: "job", id: "a1", jobKind: "agent", title: "one" },
      { kind: "job", id: "a2", jobKind: "agent", title: "two" },
      { kind: "jobs", ids: ["a2"] },
    ]);
    expect(state.jobs.map((job) => [job.id, job.open])).toEqual([["a1", false], ["a2", true]]);
  });

  it("seeds a live job the ledger never saw start", () => {
    // 상한에 걸린 저널이 잡의 시작을 밀어낸 재접속. 셸은 맥박을 내지 않으므로 이 스냅숏이
    // 그 작업이 살아 있다는 유일한 근거다 — 버리면 탭·배지·스트립에서 통째로 사라진다.
    const state = fold([
      { kind: "job", id: "a1", jobKind: "agent", title: "known" },
      { kind: "jobs", ids: ["a1", "b-shell"] },
    ]);
    expect(state.jobs.map((job) => [job.id, job.open, job.kind])).toEqual([
      ["a1", true, "agent"],
      ["b-shell", true, "other"],
    ]);
  });

  it("lets the real start event fill in a seeded placeholder", () => {
    const state = fold([
      { kind: "jobs", ids: ["b1"] },
      { kind: "job", id: "b1", jobKind: "shell", title: "sleep 60", toolUseId: "c1" },
    ]);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toEqual(expect.objectContaining({ id: "b1", kind: "shell", title: "sleep 60", open: true, toolUseId: "c1" }));
  });

  it("records a stopped job as stopped", () => {
    const state = fold([
      { kind: "job", id: "b1", jobKind: "shell", title: "sleep 45" },
      { kind: "jobs", ids: [] },
      { kind: "job-end", id: "b1", status: "stopped", durationMs: 28000 },
    ]);
    expect(state.jobs[0]).toEqual(expect.objectContaining({ open: false, status: "stopped", durationMs: 28000 }));
  });

  it("does not erase a known outcome when a later report cannot be recognized", () => {
    const state = fold([
      { kind: "job", id: "w1", jobKind: "workflow", title: "w" },
      { kind: "job-end", id: "w1", status: "completed", summary: "done" },
      { kind: "job-end", id: "w1", tokens: 99 },
    ]);
    expect(state.jobs[0]).toEqual(expect.objectContaining({ open: false, status: "completed", tokens: 99 }));
  });

  it("records an unrecognized outcome as ended without a verdict", () => {
    const state = fold([
      { kind: "job", id: "w2", jobKind: "workflow", title: "w" },
      { kind: "job-end", id: "w2", tokens: 5 },
    ]);
    expect(state.jobs[0]).toEqual(expect.objectContaining({ open: false, tokens: 5 }));
    expect(state.jobs[0]?.status).toBeUndefined();
  });

  it("seeds a job whose start was missed so a late result is not thrown away", () => {
    const state = fold([{ kind: "job-end", id: "ghost", status: "completed", summary: "OK" }]);
    expect(state.jobs).toEqual([expect.objectContaining({ id: "ghost", kind: "other", open: false, status: "completed", summary: "OK" })]);
  });

  it("replaces the stage tree instead of merging it", () => {
    const state = fold([
      { kind: "job", id: "w1", jobKind: "workflow", title: "w" },
      { kind: "job-progress", id: "w1", stages: [{ title: "Alpha", agents: [{ label: "a", state: "running" }] }] },
      { kind: "job-progress", id: "w1", stages: [{ title: "Alpha", agents: [{ label: "a", state: "done" }] }] },
    ]);
    expect(state.jobs[0]?.stages).toEqual([{ title: "Alpha", agents: [{ label: "a", state: "done" }] }]);
  });

  it("opens a fresh turn when the model wakes up after a background result", () => {
    const state = fold([
      { kind: "dispatch", text: "go" },
      { kind: "turn-start" },
      { kind: "text", text: "launched" },
      { kind: "turn-end", ok: true, answer: "launched" },
      // 백그라운드가 끝나 모델이 다시 말한다 — 세션이 turn-start를 앞세운다.
      { kind: "turn-start" },
      { kind: "text", text: "the workflow finished" },
      { kind: "turn-end", ok: true, answer: "the workflow finished" },
    ]);
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]?.dispatch).toEqual({ text: "go" });
    expect(splitAgentChatTurn(state.turns[0] as AgentChatLogState["turns"][number]).answer).toBe("launched");
    expect(state.turns[1]?.dispatch).toBeNull();
    expect(splitAgentChatTurn(state.turns[1] as AgentChatLogState["turns"][number]).answer).toBe("the workflow finished");
  });
});

describe("ledger segmentation — background job anchors", () => {
  const items: readonly AgentChatTurnItem[] = [
    { type: "text", text: "First I will look around." },
    { type: "tool", name: "Read", detail: "a.ts", id: "t1", state: "ok" },
    { type: "text", text: "Now I will delegate the audit." },
    { type: "tool", name: "Read", detail: "b.ts", id: "t2", state: "ok" },
    { type: "tool", name: "Workflow", detail: "audit", id: "job-call", state: "ok" },
    { type: "tool", name: "Read", detail: "c.ts", id: "t3", state: "ok" },
  ];
  const hasJob = (item: AgentChatTurnItem): boolean => item.id === "job-call";

  it("keeps a job anchor in the segment its note opened", () => {
    const segments = segmentAgentChatLedger(items, hasJob);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.note).toBe("First I will look around.");
    expect(segments[0]?.parts.map((part) => part.kind)).toEqual(["tally"]);
    // 잡을 낳은 호출은 그것을 부른 문장의 구간에 남는다 — 앞 문장 위로 올라가지 않는다.
    expect(segments[1]?.note).toBe("Now I will delegate the audit.");
    expect(segments[1]?.parts.some((part) => part.kind === "job")).toBe(true);
  });

  // 접힌 것이 전부 한 집계로 맨 위에 서면, 두 번째로 시작한 잡이 다섯 번째로 읽힌다.
  // 집계는 잡 앵커에서 닫히고 그 뒤가 새 집계를 연다 — 조각의 순서가 곧 일어난 순서다.
  it("splits the tally around the anchor so the segment reads in the order it happened", () => {
    const segments = segmentAgentChatLedger(items, hasJob);
    expect(segments[1]?.parts).toEqual([
      { kind: "tally", groups: [{ family: "read", count: 1 }], folded: [items[3]] },
      { kind: "job", item: items[4] },
      { kind: "tally", groups: [{ family: "read", count: 1 }], folded: [items[5]] },
    ]);
  });

  it("never folds a job step into a tally", () => {
    const segments = segmentAgentChatLedger(items, hasJob);
    const folded = segments[1]?.parts.flatMap((part) => (part.kind === "tally" ? part.folded : []));
    expect(folded?.map((item) => item.id)).toEqual(["t2", "t3"]);
  });

  it("folds the same step when it owns no job", () => {
    const segments = segmentAgentChatLedger(items);
    expect(segments[1]?.parts).toEqual([{
      kind: "tally",
      groups: [{ family: "read", count: 2 }, { family: "workflow", count: 1 }],
      folded: [items[3], items[4], items[5]],
    }]);
  });
});

/**
 * 사용자가 끊은 턴.
 *
 * 실패와 같은 자리에 두면 자기가 누른 버튼의 결과를 고장으로 읽는다. 그리고 흐르던 글에
 * Answer 이름표를 붙이면, 끝까지 쓰이지 않은 문장이 최종 답으로 굳는다.
 */
describe("stopped turn", () => {
  function runStopped(events: readonly AgentChatStreamEvent[]): AgentChatLogState {
    return events.reduce(reduceAgentChatLog, initialAgentChatLogState);
  }

  it("is neither done nor error", () => {
    const state = runStopped([
      { kind: "dispatch", text: "go" },
      { kind: "turn-start" },
      { kind: "text", text: "half a th" },
      { kind: "turn-end", ok: false, stopped: true },
    ]);
    expect(state.turns.at(-1)?.state).toBe("stopped");
  });

  it("shows what it managed to say without calling it the answer", () => {
    const state = runStopped([
      { kind: "dispatch", text: "go" },
      { kind: "turn-start" },
      { kind: "tool", name: "Read", detail: "app.ts", id: "t1" },
      { kind: "text", text: "half a th" },
      { kind: "turn-end", ok: false, stopped: true },
    ]);
    const view = splitAgentChatTurn(state.turns.at(-1)!);
    expect(view.answer).toBeNull();
    expect(view.streamingText).toBe("half a th");
    // 접힘에는 도구 줄만 남는다 — 방금 멈춘 사람이 보려는 글이 접힘 속으로 들어가면 안 된다.
    expect(view.ledger.some((item) => item.type === "text")).toBe(false);
  });

  it("still reads as an ordinary failure when nothing was stopped", () => {
    const state = runStopped([
      { kind: "dispatch", text: "go" },
      { kind: "turn-start" },
      { kind: "turn-end", ok: false },
    ]);
    expect(state.turns.at(-1)?.state).toBe("error");
  });
});

/**
 * 결말 보고의 **도착**을 세는 축.
 *
 * 백그라운드 셸은 `task_updated(killed)`가 먼저 닫고 출력 파일의 좌표는 뒤따르는
 * `task_notification`이 들고 온다. 그 알림이 status만 실어 오면 잡 레코드의 다른 필드는 하나도
 * 움직이지 않으므로, 내용으로 도착을 추론하는 화면은 두 번째 보고를 못 본다.
 */
describe("job end arrivals", () => {
  it("counts every end report, even one that carries nothing but a status", () => {
    const events: readonly AgentChatStreamEvent[] = [
      { kind: "job", id: "b1", jobKind: "shell", title: "loop" },
      { kind: "job-end", id: "b1", status: "stopped" },
      { kind: "job-end", id: "b1", status: "stopped" },
    ];
    const state = events.reduce(reduceAgentChatLog, initialAgentChatLogState);
    const job = state.jobs.find((entry) => entry.id === "b1");
    expect(job?.ends).toBe(2);
    // 두 보고가 같은 내용이라 다른 필드로는 두 번째 도착을 알아볼 수 없다.
    expect(job?.summary).toBeUndefined();
    expect(job?.durationMs).toBeUndefined();
  });

  it("starts a job at zero arrivals", () => {
    const start: AgentChatStreamEvent = { kind: "job", id: "b2", jobKind: "shell", title: "loop" };
    const state = reduceAgentChatLog(initialAgentChatLogState, start);
    expect(state.jobs.find((entry) => entry.id === "b2")?.ends).toBe(0);
  });

  it("keeps each turn's starting context so growth survives a replay", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "dispatch", text: "first" },
      { kind: "context", total: 30_000, max: 200_000, slices: [{ name: "Messages", tokens: 12_000 }] },
      { kind: "dispatch", text: "second" },
      { kind: "context", total: 42_000, max: 200_000, slices: [{ name: "Messages", tokens: 24_000 }] },
      { kind: "replay-end", turns: 2 },
    ]);
    // 각 턴은 자기가 **시작될 때**의 총량을 간직한다. 첫 턴이 더한 몫(12k)은 둘째 턴의 값에서
    // 드러나며, 마지막 턴은 아직 다음 좌표가 없어 증가분을 말하지 못한다.
    expect(state.turns.map((turn) => turn.contextBefore)).toEqual([30_000, 42_000]);
    // 전역 값은 언제나 마지막 스냅숏이다.
    expect(state.context?.total).toBe(42_000);
    expect(state.context?.max).toBe(200_000);
  });

  it("holds a context snapshot that arrives before any turn", () => {
    const state = fold([
      { kind: "replay-start" },
      { kind: "context", total: 18_000, max: 200_000, compactAt: 174_000, slices: [] },
    ]);
    expect(state.turns).toHaveLength(0);
    expect(state.context?.total).toBe(18_000);
    expect(state.context?.compactAt).toBe(174_000);
  });

  it("moves the live total without touching the measured breakdown", () => {
    const state = fold([
      { kind: "dispatch", text: "go" },
      { kind: "context", total: 30_000, max: 500_000, slices: [{ name: "Messages", tokens: 30_000 }] },
      { kind: "context-live", total: 42_768, max: 500_000 },
    ]);
    expect(state.context?.liveTotal).toBe(42_768);
    // 내역과 그 짝인 측정 총량은 그대로다 — 라이브는 카테고리를 모른다.
    expect(state.context?.total).toBe(30_000);
    expect(state.context?.slices).toEqual([{ name: "Messages", tokens: 30_000 }]);
    // 턴별 증가분은 시작 시점 값으로만 센다. 라이브가 그 자리를 건드리면 이 턴이 더한 몫이
    // 다음 턴의 증가분에서 두 번 세어진다.
    expect(state.turns.at(-1)?.contextBefore).toBe(30_000);
  });

  it("stands a live total up on its own before any measurement has arrived", () => {
    // 첫 스냅숏은 왕복 때문에 한참 뒤에 온다(실측 20~30초). 그동안 총량만 아는 것은 사실이고,
    // 빈 내역이 그 사실을 말한다.
    const state = fold([
      { kind: "dispatch", text: "go" },
      { kind: "context-live", total: 12_000, max: 500_000 },
    ]);
    expect(state.context).toMatchObject({ total: 0, liveTotal: 12_000, max: 500_000, slices: [] });
    expect(state.turns.at(-1)?.contextBefore).toBeUndefined();
  });

  it("does not let a late start-of-turn snapshot roll the number backwards", () => {
    // 시작 스냅숏은 그 턴이 시작될 때의 값이고 턴이 한참 돈 뒤에 도착한다. 그때 라이브를 버리면
    // 화면의 숫자가 뒤로 간다 — 내역만 받고 총량은 지킨다.
    const state = fold([
      { kind: "dispatch", text: "go" },
      { kind: "context-live", total: 42_768, max: 500_000 },
      { kind: "context", total: 30_000, max: 500_000, slices: [{ name: "Messages", tokens: 30_000 }] },
    ]);
    expect(state.context?.liveTotal).toBe(42_768);
    expect(state.context?.total).toBe(30_000);
    expect(state.turns.at(-1)?.contextBefore).toBe(30_000);
  });

  it("lets the end-of-turn snapshot retire the live total", () => {
    // 턴이 닫힌 뒤의 측정은 그 시점의 값이므로 라이브가 더 말할 것이 없다. 그리고 그 값은
    // 턴별 증가분의 기준을 건드리지 않는다.
    const state = fold([
      { kind: "dispatch", text: "go" },
      { kind: "context", total: 30_000, max: 500_000, slices: [{ name: "Messages", tokens: 30_000 }] },
      { kind: "context-live", total: 42_768, max: 500_000 },
      { kind: "context", asOf: "end", total: 45_476, max: 500_000, slices: [{ name: "Messages", tokens: 45_476 }] },
    ]);
    expect(state.context?.liveTotal).toBeUndefined();
    expect(state.context?.total).toBe(45_476);
    expect(state.turns.at(-1)?.contextBefore).toBe(30_000);
  });
});
