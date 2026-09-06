import { describe, expect, it } from "vitest";

import {
  chatEventsFromSdkMessage,
  chatEventsFromTranscriptLine,
  chatShellTailFromOutput,
  chatSubagentTrailFromTranscript,
  readChatCommandLaneName,
  summarizeToolInput,
  summarizeToolResult,
  type AgentChatStreamEvent,
} from "../server/agent-api/chat-events.js";
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

  it("maps a tool_result carrier to the step's outcome", () => {
    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "2 tests, OK\ntrailing noise" }],
      },
    }))).toEqual([{ kind: "tool-result", id: "t1", ok: true, summary: "2 tests, OK" }]);

    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: [{ type: "text", text: "exit 2: no such file" }] }],
      },
    }))).toEqual([{ kind: "tool-result", id: "t2", ok: false, summary: "exit 2: no such file" }]);
  });

  it.each([
    [{ type: "user", isMeta: true, message: { role: "user", content: "meta" } }],
    [{ type: "user", isSidechain: true, message: { role: "user", content: "sidechain" } }],
    // 속성 없는 리마인더는 실측 25/25가 isMeta를 달고 오므로 입구에서 걸린다.
    [{ type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>noise</system-reminder>" } }],
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
});

describe("summarizeToolResult", () => {

  it("masks obvious credential shapes", () => {
    expect(summarizeToolResult("token=sk-abcdefghijklmnopqrstuvwxyz")).toBe("token=sk-…");
    expect(summarizeToolResult("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("ghp_…");
    // 헤더 이름은 남고 토큰만 사라진다 — 무엇이 실렸는지는 읽히되 값은 나가지 않는다.
    expect(summarizeToolResult("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe("Authorization: Bearer …");
  });
});

// 클라이언트 union은 서버 union의 손 복제다 — 서버가 내보내는 모든 kind를 클라이언트 해석기가
// 그대로 받아들이는지 왕복으로 못 박는다.

/**
 * 잡 하나를 열었을 때 읽어 오는 상세.
 *
 * 서브에이전트는 자기가 **말하기로 고른** 보고만 원장에 남긴다 — 발자국은 그 옆에서 실제로
 * 한 일을 말한다. 셸에는 아예 보고랄 것이 없고 출력이 곧 산출물이다.
 */
