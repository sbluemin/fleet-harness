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
    { kind: "tool", name: "Read", detail: "a.ts" },
    { kind: "turn-end", ok: true, durationMs: 12 },
    { kind: "status", working: true },
    { kind: "error", code: "chat_turn_failed" },
  ];

  it.each(samples.map((event) => [event.kind, event] as const))("round-trips %s", (_kind, event) => {
    const parsed = readChatJournalEvent(JSON.stringify({ seq: 7, event }));
    expect(parsed).toEqual({ seq: 7, event });
  });
});
