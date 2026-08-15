import { describe, expect, it } from "vitest";

import { chatEventsFromSdkMessage, chatEventsFromTranscriptLine, summarizeToolInput, type AgentChatStreamEvent } from "../server/agent-api/chat-events.js";
import { readChatJournalEvent } from "../client/agent/chat/chat-events.js";

describe("chat transcript mapping", () => {
  it("maps a plain user line to a dispatch", () => {
    const events = chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      timestamp: "2026-08-14T01:00:00.000Z",
      message: { role: "user", content: "tighten the refund path" },
    }));
    expect(events).toEqual([{ kind: "dispatch", text: "tighten the refund path", at: Date.parse("2026-08-14T01:00:00.000Z") }]);
  });

  it("maps text-block user content and drops tool_result carriers", () => {
    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    }))).toEqual([{ kind: "dispatch", text: "hello" }]);
    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "output" }] },
    }))).toEqual([]);
  });

  it.each([
    [{ type: "user", isMeta: true, message: { role: "user", content: "meta" } }],
    [{ type: "user", isSidechain: true, message: { role: "user", content: "sidechain" } }],
    [{ type: "user", message: { role: "user", content: "<system-reminder>noise</system-reminder>" } }],
    [{ type: "mode", mode: "normal" }],
    [{ type: "file-history-snapshot" }],
  ])("stays silent for non-conversation line %#", (line) => {
    expect(chatEventsFromTranscriptLine(JSON.stringify(line))).toEqual([]);
  });

  it("maps assistant text and tool_use, and never leaks thinking", () => {
    const events = chatEventsFromTranscriptLine(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "text", text: "done." },
          { type: "tool_use", name: "Read", input: { file_path: "src/billing/refund.ts" } },
        ],
      },
    }));
    expect(events).toEqual([
      { kind: "text", text: "done." },
      { kind: "tool", name: "Read", detail: "src/billing/refund.ts" },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret reasoning");
  });

  it("tolerates malformed lines", () => {
    expect(chatEventsFromTranscriptLine("not json")).toEqual([]);
  });

  // auto-compact 이어짐 요약은 isMeta 없이 isCompactSummary만 달고 온다 — 디스패치로
  // 재생되면 "전환이 summarize했다"로 오독된다.
  it("drops compact-summary carrier lines", () => {
    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: [{ type: "text", text: "This session is being continued from a previous conversation…" }] },
    }))).toEqual([]);
  });
});

describe("chat sdk message mapping", () => {
  it("maps assistant messages like transcript lines", () => {
    expect(chatEventsFromSdkMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    })).toEqual([{ kind: "text", text: "hi" }]);
  });

  it("maps a result into turn-end with duration", () => {
    expect(chatEventsFromSdkMessage({ type: "result", subtype: "success", is_error: false, duration_ms: 1200 }))
      .toEqual([{ kind: "turn-end", ok: true, durationMs: 1200 }]);
    expect(chatEventsFromSdkMessage({ type: "result", subtype: "error_during_execution", is_error: true }))
      .toEqual([{ kind: "turn-end", ok: false }]);
  });

  // result.result는 최종 응답 텍스트다 — 성공 턴의 turn-end에 answer로 실려 클라이언트의
  // Answer 승격에 서버 권위를 준다. 실패 턴의 result는 에러 서술이므로 answer가 아니다.
  it("carries the final result text as the turn-end answer", () => {
    expect(chatEventsFromSdkMessage({ type: "result", subtype: "success", is_error: false, duration_ms: 5, result: "Final answer." }))
      .toEqual([{ kind: "turn-end", ok: true, durationMs: 5, answer: "Final answer." }]);
    expect(chatEventsFromSdkMessage({ type: "result", subtype: "success", is_error: false, result: "   " }))
      .toEqual([{ kind: "turn-end", ok: true }]);
    expect(chatEventsFromSdkMessage({ type: "result", is_error: true, result: "boom" }))
      .toEqual([{ kind: "turn-end", ok: false }]);
  });

  // 스트리밍 감각의 근거 — text_delta만 글자 단위 이벤트가 되고, thinking_delta는 공개 출력
  // 금지 불변식에 따라 여기서도 버린다.
  it("maps text_delta stream events and never thinking_delta", () => {
    expect(chatEventsFromSdkMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "chu" } },
    })).toEqual([{ kind: "text-delta", text: "chu" }]);
    expect(chatEventsFromSdkMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "secret" } },
    })).toEqual([]);
    expect(chatEventsFromSdkMessage({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "text" } },
    })).toEqual([]);
    expect(chatEventsFromSdkMessage({ type: "stream_event" })).toEqual([]);
  });

  it("ignores stream noise", () => {
    expect(chatEventsFromSdkMessage({ type: "system", subtype: "init", session_id: "abc" })).toEqual([]);
  });
});

describe("summarizeToolInput", () => {
  it("prefers coordinate-like fields and caps length", () => {
    expect(summarizeToolInput({ file_path: "a.ts", content: "HUGE FILE BODY" })).toBe("a.ts");
    expect(summarizeToolInput({ command: `run ${"x".repeat(400)}` }).length).toBeLessThanOrEqual(160);
    expect(summarizeToolInput({ unrelated: 1 })).toBe("");
  });

  // 브라우저로 나가는 스트림에 raw 절대 경로를 싣지 않는다(Console 보안 계약) —
  // cwd 안은 상대화, 밖은 마지막 두 조각 축약, 상대 경로는 그대로.
  it("relativizes absolute paths against the operation cwd", () => {
    const options = { cwd: "/Users/someone/workspace/project" };
    expect(summarizeToolInput({ file_path: "/Users/someone/workspace/project/src/a.ts" }, options)).toBe("src/a.ts");
    expect(summarizeToolInput({ path: "/Users/someone/.claude/projects/x/session.jsonl" }, options)).toBe("…/x/session.jsonl");
    expect(summarizeToolInput({ file_path: "src/a.ts" }, options)).toBe("src/a.ts");
    expect(summarizeToolInput({ file_path: "/etc/hosts" })).toBe("…/etc/hosts");
  });

  // 자유 텍스트 필드(command 등)의 경로 토큰도 원문 절대 경로로 나가지 않는다 —
  // cwd 접두는 `.`, 홈 접두는 `~`로 바꾸는 셸 관용 표기다.
  it("normalizes cwd and home prefixes inside free-text fields", async () => {
    const { homedir } = await import("node:os");
    const options = { cwd: "/Users/someone/workspace/project" };
    expect(summarizeToolInput({ command: "cat /Users/someone/workspace/project/src/secret.ts" }, options))
      .toBe("cat ./src/secret.ts");
    expect(summarizeToolInput({ command: `ls ${homedir()}/notes` }, options)).toBe("ls ~/notes");
  });
});

// 클라이언트 union은 서버 union의 손 복제다 — 서버가 내보내는 모든 kind를 클라이언트 해석기가
// 그대로 받아들이는지 왕복으로 못 박는다.
describe("client/server event vocabulary parity", () => {
  const samples: readonly AgentChatStreamEvent[] = [
    { kind: "replay-start" },
    { kind: "replay-end", turns: 3 },
    { kind: "dispatch", text: "hello", at: 1755130000000 },
    { kind: "turn-start", at: 1755130000000 },
    { kind: "text", text: "body" },
    { kind: "text-delta", text: "bo" },
    { kind: "tool", name: "Read", detail: "a.ts" },
    { kind: "turn-end", ok: true, durationMs: 12 },
    { kind: "turn-end", ok: true, durationMs: 12, answer: "Final answer." },
    { kind: "error", code: "chat_turn_failed" },
  ];

  it.each(samples.map((event) => [event.kind, event] as const))("round-trips %s", (_kind, event) => {
    const parsed = readChatJournalEvent(JSON.stringify({ seq: 7, event }));
    expect(parsed).toEqual({ seq: 7, event });
  });
});
