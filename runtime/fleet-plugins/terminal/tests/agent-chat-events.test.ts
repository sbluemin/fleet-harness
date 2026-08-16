import { describe, expect, it } from "vitest";

import {
  chatEventsFromSdkMessage,
  chatEventsFromTranscriptLine,
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

  it("maps text-block user content and never reads a tool_result carrier as a dispatch", () => {
    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    }))).toEqual([{ kind: "dispatch", text: "hello" }]);
    // 좌표(tool_use_id)가 없는 결과는 세울 스텝이 없다 — 조용히 버린다.
    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "output" }] },
    }))).toEqual([]);
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

  it("carries the tool_use id, the change it makes, and whether it left the Theater", () => {
    const events = chatEventsFromTranscriptLine(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/repo/src/a.ts", content: "one\ntwo\nthree" } },
          { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/elsewhere/b.ts", old_string: "x", new_string: "y\nz" } },
        ],
      },
    }), { cwd: "/repo" });
    expect(events).toEqual([
      { kind: "tool", name: "Write", detail: "src/a.ts", id: "t1", change: { file: "src/a.ts", added: 3, removed: 0 } },
      {
        kind: "tool",
        name: "Edit",
        detail: "…/elsewhere/b.ts",
        id: "t2",
        outside: true,
        change: { file: "…/elsewhere/b.ts", added: 2, removed: 1 },
      },
    ]);
  });

  // NotebookEdit만 notebook_path를 쓴다 — 좌표 목록에서 빠지면 대상도 변경 장부도 없이 지나가고,
  // 쓰기 계열의 성공 결과는 싣지 않으므로 노트북 편집이 원장에서 사실상 보이지 않게 된다.
  it("reads NotebookEdit's notebook_path as its coordinate", () => {
    const events = chatEventsFromTranscriptLine(JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "NotebookEdit", input: { notebook_path: "/repo/analysis.ipynb", new_source: "print(1)" } }],
      },
    }), { cwd: "/repo" });
    expect(events).toEqual([
      { kind: "tool", name: "NotebookEdit", detail: "analysis.ipynb", id: "t1", change: { file: "analysis.ipynb", added: 0, removed: 0 } },
    ]);
  });

  // 문자열 접두만 보면 `/repo/../etc/passwd`가 Theater 안쪽이 된다 — 표식이 지켜야 할 바로 그 경우다.
  it("resolves dot segments before judging Theater containment", () => {
    const events = chatEventsFromTranscriptLine(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/repo/../etc/passwd", content: "x" } }] },
    }), { cwd: "/repo" });
    expect(events[0]).toMatchObject({ outside: true, detail: "…/etc/passwd" });
  });

  it("marks a NotebookEdit that lands outside the Theater", () => {
    const events = chatEventsFromTranscriptLine(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "NotebookEdit", input: { notebook_path: "/elsewhere/x.ipynb" } }] },
    }), { cwd: "/repo" });
    expect(events[0]).toMatchObject({ outside: true, detail: "…/elsewhere/x.ipynb" });
  });

  it("puts no change on a read-only tool", () => {
    const events = chatEventsFromTranscriptLine(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }] },
    }), { cwd: "/repo" });
    expect(events).toEqual([{ kind: "tool", name: "Bash", detail: "pnpm test", id: "t1" }]);
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

  /**
   * 도구 이름은 인자 JSON보다 먼저 온다. 실측(2026-08-15, xAI Grok-4.6)에서 프로바이더가
   * 이름을 올린 뒤 인자가 끝나기까지 8.5초가 걸렸고, 게이트웨이는 그 자리에서
   * content_block_start를 낸다(core-ai-gateway anthropic/protocol.ts). 이 분기를 놓치면
   * 그 8.5초 동안 패널이 무엇을 하는지 말하지 못한다.
   */
  it("opens a step from a tool_use block start, before its arguments land", () => {
    expect(chatEventsFromSdkMessage({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Write", input: {} } },
    })).toEqual([{ kind: "tool-start", id: "t1", name: "Write" }]);
    // 좌표가 될 id나 이름이 없으면 세울 스텝이 없다.
    expect(chatEventsFromSdkMessage({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", name: "Write" } },
    })).toEqual([]);
  });

  it("maps an SDK user message carrying a tool_result to that step's outcome", () => {
    expect(chatEventsFromSdkMessage({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    })).toEqual([{ kind: "tool-result", id: "t1", ok: true, summary: "ok" }]);
  });

  /**
   * Read·Grep·WebFetch의 성공 결과는 곧 내용이고, 쓰기의 성공 결과는 변경 줄 수가 이미 말한다 —
   * 그 첫 줄을 칩으로 실으면 스텝 줄이 파일 본문 유출 경로가 된다. 실패는 예외다.
   */
  it("keeps content-shaped success results off the wire, but never an error", () => {
    const toolNames = new Map([["t1", "Read"], ["t2", "Write"], ["t3", "Bash"], ["t4", "Read"]]);
    expect(chatEventsFromSdkMessage({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "     1  #!/usr/bin/env python3" },
          { type: "tool_result", tool_use_id: "t2", content: "File created successfully" },
          { type: "tool_result", tool_use_id: "t3", content: "2 tests, OK" },
          { type: "tool_result", tool_use_id: "t4", is_error: true, content: "ENOENT: no such file" },
        ],
      },
    }, { toolNames })).toEqual([
      { kind: "tool-result", id: "t1", ok: true, summary: "" },
      { kind: "tool-result", id: "t2", ok: true, summary: "" },
      { kind: "tool-result", id: "t3", ok: true, summary: "2 tests, OK" },
      { kind: "tool-result", id: "t4", ok: false, summary: "ENOENT: no such file" },
    ]);
  });

  it("ignores stream noise", () => {
    expect(chatEventsFromSdkMessage({ type: "system", subtype: "init", session_id: "abc" })).toEqual([]);
  });
});

describe("summarizeToolResult", () => {
  it("keeps the first line only, under a cap", () => {
    expect(summarizeToolResult("first line\nsecond line")).toBe("first line");
    expect(summarizeToolResult("\n\n  padded  \nrest")).toBe("padded");
    expect(summarizeToolResult("x".repeat(400)).length).toBeLessThanOrEqual(120);
    expect(summarizeToolResult(undefined)).toBe("");
  });

  it("normalizes workspace and home paths like the input summary does", () => {
    expect(summarizeToolResult("File created at /repo/src/a.ts", { cwd: "/repo" }))
      .toBe("File created at ./src/a.ts");
  });

  // 도구 결과는 모델이 고른 문장이 아니라 실행 출력이 그대로 흐르는 경로다 — 가장 흔한
  // 자격 증명 모양은 원문으로 남기지 않는다.
  // cwd·홈 밖의 절대 경로는 두 접두 정규화를 그냥 통과한다 — 실측에서 실패한 쓰기의 EACCES가
  // 다른 사용자의 홈을 실어 왔다. 원장 경로 필드와 같은 규칙(마지막 두 조각)으로 접는다.
  it("abbreviates absolute paths that belong to neither the workspace nor this home", () => {
    expect(summarizeToolResult("EACCES: permission denied, mkdir '/Users/someone-else/Documents/CATE'", { cwd: "/repo" }))
      .toBe("EACCES: permission denied, mkdir '…/Documents/CATE'");
    expect(summarizeToolResult("/srv/private/project/file.ts: syntax error", { cwd: "/repo" }))
      .toBe("…/project/file.ts: syntax error");
    // 이미 정규화된 표기와 URL은 건드리지 않는다.
    expect(summarizeToolResult("wrote ./src/a.ts", { cwd: "/repo" })).toBe("wrote ./src/a.ts");
    expect(summarizeToolResult("fetched https://example.com/a/b/c")).toBe("fetched https://example.com/a/b/c");
  });

  // Console은 Windows를 지원하고, 공백이 든 경로는 오류 메시지에서 거의 언제나 따옴표에 싸여 온다.
  it("abbreviates Windows, UNC, quoted-with-space and single-segment absolute paths", () => {
    expect(summarizeToolResult("cannot open C:\\Users\\alice\\Private\\key.txt"))
      .toBe("cannot open …/Private/key.txt");
    expect(summarizeToolResult("copy failed from \\\\server\\share\\team\\key.txt"))
      .toBe("copy failed from …/team/key.txt");
    expect(summarizeToolResult("can't open file '/Users/alice/My Project/key.txt'"))
      .toBe("can't open file '…/My Project/key.txt'");
    expect(summarizeToolResult("no such file /secret")).toBe("no such file …/secret");
    // 접은 경로를 두 번 접지 않는다.
    expect(summarizeToolResult("mkdir '/a/b/My Dir/c.txt' failed")).toBe("mkdir '…/My Dir/c.txt' failed");
  });

  // 조각의 첫 글자를 열거하면 비ASCII 경로가 통째로 빠져나간다 — 경로는 경계로 잡는다.
  it("folds paths whose components are not ASCII", () => {
    expect(summarizeToolResult("failed /équipe/alice/key.txt")).toBe("failed …/alice/key.txt");
    expect(summarizeToolResult("failed /사용자/마스터/비밀.txt")).toBe("failed …/마스터/비밀.txt");
    expect(summarizeToolResult("open C:\\사용자\\alice\\key.txt")).toBe("open …/alice/key.txt");
  });

  // 여는 꺾쇠도 경계다 — 규칙이 "여는 구분자 뒤"인데 이것만 빠져 있었다.
  it("treats an angle bracket as a path boundary", () => {
    expect(summarizeToolResult("Bash output: </srv/private/key.txt>"))
      .toBe("Bash output: <…/private/key.txt>");
  });

  // 경계 규칙이 산문 속 슬래시까지 먹으면 요약이 못 쓰게 된다 — 경로만 잡는다.
  it("leaves prose slashes, URLs and already-folded paths alone", () => {
    expect(summarizeToolResult("저장 읽기/쓰기를 옮김")).toBe("저장 읽기/쓰기를 옮김");
    expect(summarizeToolResult("pass and/or fail")).toBe("pass and/or fail");
    expect(summarizeToolResult("see https://example.com/a/b/c")).toBe("see https://example.com/a/b/c");
    expect(summarizeToolResult("already …/b/c.txt")).toBe("already …/b/c.txt");
  });

  it("masks obvious credential shapes", () => {
    expect(summarizeToolResult("token=sk-abcdefghijklmnopqrstuvwxyz")).toBe("token=sk-…");
    expect(summarizeToolResult("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("ghp_…");
    // 헤더 이름은 남고 토큰만 사라진다 — 무엇이 실렸는지는 읽히되 값은 나가지 않는다.
    expect(summarizeToolResult("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe("Authorization: Bearer …");
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
    { kind: "tool-start", id: "t1", name: "Write" },
    { kind: "tool", name: "Read", detail: "a.ts" },
    { kind: "tool", name: "Write", detail: "a.ts", id: "t1", outside: true, change: { file: "a.ts", added: 3, removed: 1 } },
    { kind: "tool-result", id: "t1", ok: true, summary: "File created" },
    { kind: "tool-result", id: "t2", ok: false, summary: "exit 2" },
    { kind: "turn-end", ok: true, durationMs: 12 },
    { kind: "turn-end", ok: true, durationMs: 12, answer: "Final answer." },
    { kind: "error", code: "chat_turn_failed" },
  ];

  it.each(samples.map((event) => [event.kind, event] as const))("round-trips %s", (_kind, event) => {
    const parsed = readChatJournalEvent(JSON.stringify({ seq: 7, event }));
    expect(parsed).toEqual({ seq: 7, event });
  });
});

describe("background job mapping", () => {
  it("maps task_started for each of the three kinds", () => {
    expect(chatEventsFromSdkMessage({
      type: "system", subtype: "task_started",
      task_id: "b1", tool_use_id: "call-1", description: "Sleep then echo", task_type: "local_bash",
    })).toEqual([expect.objectContaining({ kind: "job", id: "b1", jobKind: "shell", title: "Sleep then echo", toolUseId: "call-1" })]);

    expect(chatEventsFromSdkMessage({
      type: "system", subtype: "task_started",
      task_id: "a1", description: "ping", task_type: "local_agent", subagent_type: "general-purpose",
    })).toEqual([expect.objectContaining({ kind: "job", id: "a1", jobKind: "agent", who: "general-purpose" })]);

    expect(chatEventsFromSdkMessage({
      type: "system", subtype: "task_started",
      task_id: "w1", description: "two tiny phases", task_type: "local_workflow", workflow_name: "two-step",
    })).toEqual([expect.objectContaining({ kind: "job", id: "w1", jobKind: "workflow", who: "two-step" })]);
  });

  it("keeps an unknown task_type visible instead of dropping it", () => {
    expect(chatEventsFromSdkMessage({
      type: "system", subtype: "task_started", task_id: "x1", description: "?", task_type: "remote_thing",
    })).toEqual([expect.objectContaining({ kind: "job", id: "x1", jobKind: "other" })]);
  });

  it("folds workflow_progress into a stage tree carrying each agent's pinned model", () => {
    const [event] = chatEventsFromSdkMessage({
      type: "system", subtype: "task_progress", task_id: "w1",
      usage: { total_tokens: 11299, tool_uses: 0, duration_ms: 74303 },
      last_tool_name: "StructuredOutput",
      workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Alpha" },
        { type: "workflow_phase", index: 2, title: "Beta" },
        { type: "workflow_agent", index: 1, label: "scan", phaseTitle: "Alpha", model: "claude-gateway--cursor--auto", state: "done", tokens: 1646, toolCalls: 0, durationMs: 28041, resultPreview: "A" },
        { type: "workflow_agent", index: 2, label: "verify", phaseTitle: "Beta", model: "claude-gateway--cursor--auto", state: "running" },
      ],
    }) as readonly AgentChatStreamEvent[];
    expect(event).toEqual(expect.objectContaining({
      kind: "job-progress", id: "w1", tokens: 11299, tools: 0, durationMs: 74303, lastTool: "StructuredOutput",
      stages: [
        { title: "Alpha", agents: [{ label: "scan", model: "claude-gateway--cursor--auto", state: "done", tokens: 1646, tools: 0, durationMs: 28041, result: "A" }] },
        { title: "Beta", agents: [{ label: "verify", model: "claude-gateway--cursor--auto", state: "running" }] },
      ],
    }));
  });

  it("keeps a stage with no agents so an empty phase is not mistaken for a missing one", () => {
    const [event] = chatEventsFromSdkMessage({
      type: "system", subtype: "task_progress", task_id: "w2",
      workflow_progress: [{ type: "workflow_phase", index: 1, title: "Alpha" }],
    }) as readonly AgentChatStreamEvent[];
    expect(event).toEqual({ kind: "job-progress", id: "w2", stages: [{ title: "Alpha", agents: [] }] });
  });

  it("says nothing about stages when the run reports none", () => {
    expect(chatEventsFromSdkMessage({ type: "system", subtype: "task_progress", task_id: "w3" }))
      .toEqual([{ kind: "job-progress", id: "w3" }]);
  });

  it("maps a stopped task to stopped, never to completed", () => {
    expect(chatEventsFromSdkMessage({
      type: "system", subtype: "task_notification", task_id: "b1", status: "stopped",
      summary: "Killed", usage: { total_tokens: 0, tool_uses: 0, duration_ms: 45000 },
    })).toEqual([{ kind: "job-end", id: "b1", status: "stopped", summary: "Killed", tokens: 0, tools: 0, durationMs: 45000 }]);

    expect(chatEventsFromSdkMessage({
      type: "system", subtype: "task_updated", task_id: "b1", patch: { status: "killed", end_time: 1 },
    })).toEqual([{ kind: "job-end", id: "b1", status: "stopped" }]);
  });

  it("carries the subagent's own report through the tool-result gate", () => {
    expect(chatEventsFromSdkMessage({
      type: "system", subtype: "task_notification", task_id: "a1", status: "completed",
      summary: "Read /Users/someone/secret/notes.md and found sk-abcdefghijklmnopqrst",
    }, { cwd: "/repo" })).toEqual([expect.objectContaining({
      kind: "job-end", id: "a1", status: "completed",
      summary: "Read …/secret/notes.md and found sk-…",
    })]);
  });

  it("replaces the live set from background_tasks_changed rather than counting it", () => {
    expect(chatEventsFromSdkMessage({
      type: "system", subtype: "background_tasks_changed",
      tasks: [{ task_id: "a1", task_type: "local_agent", description: "x" }, { task_id: "w1" }],
    })).toEqual([{ kind: "jobs", ids: ["a1", "w1"] }]);

    expect(chatEventsFromSdkMessage({ type: "system", subtype: "background_tasks_changed", tasks: [] }))
      .toEqual([{ kind: "jobs", ids: [] }]);
  });

  it("stays silent on system subtypes it does not own", () => {
    expect(chatEventsFromSdkMessage({ type: "system", subtype: "thinking_tokens", estimated_tokens: 5 })).toEqual([]);
    expect(chatEventsFromSdkMessage({ type: "system", subtype: "init", tools: ["Bash"] })).toEqual([]);
  });

  it("round-trips every job event through the journal reader", () => {
    const events: readonly AgentChatStreamEvent[] = [
      { kind: "job", id: "w1", jobKind: "workflow", title: "two-step", toolUseId: "c1", who: "two-step", at: 1786858148878 },
      { kind: "job-progress", id: "w1", tokens: 10, tools: 2, durationMs: 30, lastTool: "Read", note: "Beta", stages: [{ title: "Alpha", agents: [{ label: "scan", model: "m", state: "done", tokens: 1, tools: 0, durationMs: 2, result: "A" }] }] },
      { kind: "job-end", id: "w1", status: "completed", summary: "done", tokens: 11, tools: 2, durationMs: 31 },
      { kind: "jobs", ids: ["w1"] },
    ];
    for (const event of events) {
      expect(readChatJournalEvent(JSON.stringify({ seq: 1, event }))).toEqual({ seq: 1, event });
    }
  });
});
