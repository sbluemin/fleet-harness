import os from "node:os";
import path from "node:path";

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
} from "../../features/execution/host/agent/chat-events.js";
import { LAUNCH_ATTACHMENT_INSTRUCTION_PREFIX } from "../../features/execution/host/agent/launch-attachments.js";
import { readChatJournalEvent } from "../../features/execution/client/agent/chat/chat-events.js";

describe("chat transcript mapping", () => {
  it("maps a plain user line to a dispatch", () => {
    const events = chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      timestamp: "2026-08-14T01:00:00.000Z",
      message: { role: "user", content: "tighten the refund path" },
    }));
    expect(events).toEqual([{ kind: "dispatch", text: "tighten the refund path", at: Date.parse("2026-08-14T01:00:00.000Z") }]);
  });

  it("keeps the attachment path out of the ledger and carries a preview coordinate instead", () => {
    const filePath = path.join(os.tmpdir(), "fleet-attachments-abc123", "attachment-xyz", "image.png");
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: `look at this\n\n${LAUNCH_ATTACHMENT_INSTRUCTION_PREFIX}${filePath}` },
    });

    expect(chatEventsFromTranscriptLine(line, { resolveAttachmentId: () => "att-1" }))
      .toEqual([{ kind: "dispatch", text: "look at this", attachments: [{ id: "att-1" }] }]);
    // 스토어가 모르는 경로(지난 프로세스가 만든 것)도 경로를 되살리지 않는다 — 자리만 남는다.
    expect(chatEventsFromTranscriptLine(line))
      .toEqual([{ kind: "dispatch", text: "look at this", attachments: [{ lapsed: true }] }]);
    // 사람이 같은 문장을 친 경우는 첨부가 아니다 — 보관소 경로일 때만 걷는다.
    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      message: { role: "user", content: `${LAUNCH_ATTACHMENT_INSTRUCTION_PREFIX}/tmp/notes/image.png` },
    }))).toEqual([{ kind: "dispatch", text: `${LAUNCH_ATTACHMENT_INSTRUCTION_PREFIX}/tmp/notes/image.png` }]);
  });

  it("maps a tool_result carrier to the step's outcome", () => {
    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "2 tests, OK\ntrailing noise" }],
      },
    }))).toEqual([{ kind: "tool-result", id: "t1", ok: true, summary: "2 tests, OK", toolDetail: { sections: [{ kind: "result", text: "2 tests, OK\ntrailing noise" }] } }]);

    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: [{ type: "text", text: "exit 2: no such file" }] }],
      },
    }))).toEqual([{ kind: "tool-result", id: "t2", ok: false, summary: "exit 2: no such file", toolDetail: { sections: [{ kind: "result", text: "exit 2: no such file" }] } }]);
    const wrapped = chatEventsFromTranscriptLine(JSON.stringify({ type: "user", message: {
      content: [{ type: "tool_result", tool_use_id: "t3", is_error: true, content: "<tool_use_error>Permission denied</tool_use_error>" }],
    } }));
    expect(wrapped).toEqual([{ kind: "tool-result", id: "t3", ok: false, summary: "Permission denied", toolDetail: {
      sections: [{ kind: "result", text: "<tool_use_error>Permission denied</tool_use_error>" }],
    } }]);
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

  it("bounds and masks tool detail through live, transcript replay and browser DTOs", () => {
    const cwd = path.join(os.tmpdir(), "fleet-chat-detail");
    const source = `${cwd}/src/example.ts`;
    const input = { file_path: source, content: `const token = "sk-abcdefghijklmnopqrstuvwxyz";\nconst api_key = "private-value";\n${"line\n".repeat(240)}` };
    const assistant = { type: "assistant", message: { content: [{ type: "tool_use", id: "call-1", name: "Write", input }] } };
    const opts = { cwd, toolNames: new Map([["call-1", "Write"]]) };
    const live = chatEventsFromSdkMessage(assistant, opts);
    const replayed = chatEventsFromTranscriptLine(JSON.stringify(assistant), opts);
    expect(live).toEqual(replayed);
    const event = readChatJournalEvent(JSON.stringify({ seq: 1, event: live[0] }));
    expect(event?.event.kind).toBe("tool");
    const detail = event?.event.kind === "tool" ? event.event.toolDetail : undefined;
    expect(detail?.sections[0]?.kind).toBe("write");
    expect(detail?.sections[0]?.truncated).toBe(true);
    expect(JSON.stringify(detail)).toContain("[가림]");
    expect(JSON.stringify(detail)).not.toContain("private-value");
    expect(JSON.stringify(detail)).not.toContain(cwd);
    const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "Wrote the file." }] } };
    expect(chatEventsFromSdkMessage(result, opts)).toEqual(chatEventsFromTranscriptLine(JSON.stringify(result), opts));
    expect(live[0]).toMatchObject({ change: { added: 0, removed: 0, written: 242 } });
    const read = chatEventsFromSdkMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "  100→export const item = 1;\n  101\t</div>" }] } }, {
      cwd, toolNames: new Map([["read-1", "Read"]]),
    })[0];
    expect(read).toMatchObject({ kind: "tool-result", toolDetail: { sections: [{ kind: "read", firstLine: 100, text: "export const item = 1;\n</div>" }] } });
    const edited = chatEventsFromSdkMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: {
      file_path: source, old_string: "const path = '/api/v1/x';", new_string: "  /** Optional note */\n  </div>\n  const path = '/api/v1/x';\n  const file = '/var/private-owner/secret.txt';",
    } }] } }, { cwd })[0];
    expect(edited).toMatchObject({ kind: "tool", toolDetail: { sections: [
      { kind: "before", text: "const path = '/api/v1/x';" },
      { kind: "after", text: "  /** Optional note */\n  </div>\n  const path = '/api/v1/x';\n  const file = '…/private-owner/secret.txt';", masked: true },
    ] } });
    const code = "readonly token: string;\npassword?: string;\nexport const config = { auth: true, apiKey: process.env.API_KEY };\nconst fromEnv = { token: env.FLEET_TOKEN };";
    const maskedCode = chatEventsFromSdkMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "write-2", name: "Write", input: {
      file_path: source, content: `${code}\nconst password = \"hunter2secretvalue\";\n\"api_key\": \"abc123secretvalue\"`,
    } }] } }, { cwd })[0];
    const displayed = maskedCode?.kind === "tool" ? maskedCode.toolDetail?.sections[0]?.text ?? "" : "";
    expect(displayed).toContain(code);
    expect(displayed).not.toContain("hunter2secretvalue");
    expect(displayed).not.toContain("abc123secretvalue");
    const longOutput = `${"older\n".repeat(70)}FLEET_TOKEN=private-value\n${"newer\n".repeat(20)}`;
    const shellResult = chatEventsFromSdkMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "shell-1", content: longOutput }] } }, {
      cwd, toolNames: new Map([["shell-1", "Bash"]]),
    })[0];
    expect(shellResult?.kind).toBe("tool-result");
    const output = shellResult?.kind === "tool-result" ? shellResult.toolDetail?.sections[0] : undefined;
    expect(output?.truncated).toBe(true);
    expect(output?.text.split("\n").length).toBeLessThanOrEqual(60);
    expect(output?.text).not.toContain("private-value");
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
    expect(summarizeToolInput({ command: "API_KEY=sk-abcdefghijklmnopqrstuvwxyz run" })).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});

describe("chat SDK job mapping", () => {
  it("does not treat a workflow_progress model pin as the actual model", () => {
    expect(chatEventsFromSdkMessage({
      type: "system",
      subtype: "task_progress",
      task_id: "wf-1",
      description: "running",
      usage: { total_tokens: 12, tool_uses: 1, duration_ms: 40 },
      workflow_progress: [{
        type: "workflow_agent",
        label: "composer-run",
        phaseTitle: "Measure",
        model: "claude-gateway--xai--grok-4",
        agentId: "a1b2c3d4e5f6a7b8",
        state: "done",
      }],
    })).toEqual([{
      kind: "job-progress",
      id: "wf-1",
      note: "running",
      tokens: 12,
      tools: 1,
      durationMs: 40,
      stages: [{ title: "Measure", agents: [{ label: "composer-run", state: "done" }] }],
    }]);
  });
});
