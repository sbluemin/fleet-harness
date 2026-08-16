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
        groups: [{ family: "read", count: 2 }],
        folded: [items[1], items[2]],
        inline: [],
        running: [],
      },
      {
        note: "이제 고치고 돌리겠습니다.",
        groups: [{ family: "edit", count: 1 }, { family: "run", count: 2 }],
        folded: [items[4], items[5], items[6]],
        inline: [],
        running: [],
      },
    ]);
  });

  it("opens a leading segment when tools arrive before any note", () => {
    const items = [tool("Read"), note("읽었습니다."), tool("Bash")];
    const segments = segmentAgentChatLedger(items);
    expect(segments[0]).toEqual({
      groups: [{ family: "read", count: 1 }],
      folded: [items[0]],
      inline: [],
      running: [],
    });
    expect(segments[1]?.note).toBe("읽었습니다.");
  });

  it("keeps the failure and the outside write on their own rows inside their segment", () => {
    const failed = tool("Bash", { state: "fail", result: "exit 2" });
    const outside = tool("Write", { outside: true, detail: "…/elsewhere/a.ts" });
    const segments = segmentAgentChatLedger([note("해보겠습니다."), tool("Read"), failed, outside]);
    expect(segments[0]?.inline).toEqual([failed, outside]);
    expect(segments[0]?.groups).toEqual([{ family: "read", count: 1 }]);
  });

  // 진행 중에는 마지막 구간만 열려 있다 — 방금 무엇을 했는지가 곧 "일하는 중"이다.
  it("leaves only the last segment open while the turn runs", () => {
    const items = [
      note("먼저 읽겠습니다."), tool("Read"), tool("Read"),
      note("이제 돌리겠습니다."), tool("Bash"), tool("Write"), tool("Read", { state: "running" }),
    ];
    const segments = segmentAgentChatLedger(items, 4);
    expect(segments[0]).toEqual({
      note: "먼저 읽겠습니다.",
      groups: [{ family: "read", count: 2 }],
      folded: [items[1], items[2]],
      inline: [],
      running: [],
    });
    expect(segments[1]?.groups).toEqual([]);
    expect(segments[1]?.inline).toEqual([items[4], items[5]]);
    expect(segments[1]?.running).toEqual([items[6]]);
  });

  it("folds the last segment too once the turn is done", () => {
    const items = [note("돌리겠습니다."), tool("Bash"), tool("Write")];
    expect(segmentAgentChatLedger(items, 0)[0]?.inline).toEqual([]);
    expect(segmentAgentChatLedger(items, 0)[0]?.groups).toEqual([
      { family: "run", count: 1 },
      { family: "write", count: 1 },
    ]);
  });

  // 결과 없이 닫힌 스텝을 과거형으로 세면, 같은 이유로 변경 장부에서 뺀 쓰기를 원장이
  // 다시 "씀"이라고 말한다 — 두 표면이 어긋난다. 확인되지 않은 것은 줄을 지킨다.
  it("never counts a result-less step in the past-tense tally", () => {
    const unconfirmed = tool("Write", { state: "done" });
    const segments = segmentAgentChatLedger([note("쓰겠습니다."), tool("Read"), unconfirmed]);
    expect(segments[0]?.groups).toEqual([{ family: "read", count: 1 }]);
    expect(segments[0]?.inline).toEqual([unconfirmed]);
  });

  // 접힌 것은 감춘 것이 아니다 — 집계 줄을 누르면 그 줄이 세고 있던 스텝이 순서대로 나온다.
  it("carries the steps a tally counted so the line can unfold them", () => {
    const items = [note("보겠습니다."), tool("Read"), tool("Bash"), tool("Read")];
    const segment = segmentAgentChatLedger(items)[0];
    expect(segment?.groups).toEqual([{ family: "read", count: 2 }, { family: "run", count: 1 }]);
    expect(segment?.folded).toEqual([items[1], items[2], items[3]]);
  });

  it("counts an unknown tool under its own name", () => {
    const segments = segmentAgentChatLedger([tool("SomeMcpTool"), tool("SomeMcpTool"), tool("Other")]);
    expect(segments[0]?.groups).toEqual([
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

describe("ledger segmentation — pinned steps", () => {
  const items: readonly AgentChatTurnItem[] = [
    { type: "text", text: "First I will look around." },
    { type: "tool", name: "Read", detail: "a.ts", id: "t1", state: "ok" },
    { type: "text", text: "Now I will delegate the audit." },
    { type: "tool", name: "Read", detail: "b.ts", id: "t2", state: "ok" },
    { type: "tool", name: "Workflow", detail: "audit", id: "job-call", state: "ok" },
    { type: "tool", name: "Read", detail: "c.ts", id: "t3", state: "ok" },
  ];
  const pinned = (item: AgentChatTurnItem): boolean => item.id === "job-call";

  it("keeps a pinned step in the segment its note opened", () => {
    const segments = segmentAgentChatLedger(items, 0, pinned);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.note).toBe("First I will look around.");
    expect(segments[0]?.inline).toEqual([]);
    // 잡을 낳은 호출은 그것을 부른 문장의 구간에 남는다 — 앞 문장 위로 올라가지 않는다.
    expect(segments[1]?.note).toBe("Now I will delegate the audit.");
    expect(segments[1]?.inline.map((item) => item.id)).toEqual(["job-call"]);
  });

  it("never folds a pinned step into the tally", () => {
    const segments = segmentAgentChatLedger(items, 0, pinned);
    expect(segments[1]?.folded.map((item) => item.id)).toEqual(["t2", "t3"]);
    expect(segments[1]?.groups).toEqual([{ family: "read", count: 2 }]);
  });

  it("folds the same step when nothing pins it", () => {
    const segments = segmentAgentChatLedger(items, 0);
    expect(segments[1]?.inline).toEqual([]);
    expect(segments[1]?.folded.map((item) => item.id)).toEqual(["t2", "job-call", "t3"]);
  });

  it("does not spend a live-window slot on a pinned step", () => {
    // 열린 구간의 최근 창은 접힐 수 있었던 스텝을 위한 자리다. 이미 줄을 지키는 스텝이 그 자리를
    // 쓰면 접히지 않을 것 하나가 접히지 않을 것 하나를 더 밀어낸다.
    const segments = segmentAgentChatLedger(items, 1, pinned);
    const last = segments[1];
    expect(last?.inline.map((item) => item.id)).toEqual(["job-call", "t3"]);
    expect(last?.folded.map((item) => item.id)).toEqual(["t2"]);
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
