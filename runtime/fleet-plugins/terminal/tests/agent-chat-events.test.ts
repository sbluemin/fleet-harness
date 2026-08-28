import { describe, expect, it } from "vitest";

import {
  chatEventsFromSdkMessage,
  chatEventsFromTranscriptLine,
  chatShellTailFromOutput,
  chatSubagentTrailFromTranscript,
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
    // 속성 없는 리마인더는 실측 25/25가 isMeta를 달고 오므로 입구에서 걸린다.
    [{ type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>noise</system-reminder>" } }],
    [{ type: "mode", mode: "normal" }],
    [{ type: "file-history-snapshot" }],
  ])("stays silent for non-conversation line %#", (line) => {
    expect(chatEventsFromTranscriptLine(JSON.stringify(line))).toEqual([]);
  });

  // CLI가 user 줄로 남기지만 사람이 친 것이 아닌 운반체들. 이들이 새면 사용자가 보낸 적 없는 XML이
  // 「Quick Launch로 전달」 라벨을 달고 사용자 말풍선에 앉는다.
  //
  // 프롬프트로 주입된 것은 뒤에 응답을 달고 온다(실측: task-notification 뒤 assistant 880건).
  // 말풍선은 걷되 턴 경계는 남겨야 그 응답이 앞 턴의 Answer를 갈아치우지 않는다.
  it.each([
    // origin 축 — 백그라운드 작업 결말. 이 종류만 origin.kind가 실려 온다.
    [{
      type: "user",
      origin: { kind: "task-notification" },
      promptSource: "system",
      timestamp: "2026-08-18T06:31:00.000Z",
      message: { role: "user", content: "<task-notification>\n<task-id>wk7gy02pw</task-id>\n<status>failed</status>\n</task-notification>" },
    }],
    // 같은 결말이 origin 없이 온 판본 — 본문 축이 받는다.
    [{ type: "user", timestamp: "2026-08-18T06:31:00.000Z", message: { role: "user", content: "<task-notification>\n<status>completed</status>\n</task-notification>" } }],
    // 속성이 붙은 태그. 접두 문자열 비교로는 놓쳤던 형태다 — Fleet 자신이 붙여넣는 캐리어 완료 신호는
    // origin.kind가 human이고 promptSource가 typed라, 구조 필드로는 사람 입력과 갈리지 않는다.
    [{
      type: "user",
      origin: { kind: "human" },
      promptSource: "typed",
      timestamp: "2026-08-18T06:31:00.000Z",
      message: { role: "user", content: "<system-reminder source=\"carrier-completion\">\n[carrier:result]\n</system-reminder>" },
    }],
    // 텍스트 블록으로 실려 온 같은 운반체.
    [{ type: "user", timestamp: "2026-08-18T06:31:00.000Z", message: { role: "user", content: [{ type: "text", text: "<task-notification>\n<status>stopped</status>\n</task-notification>" }] } }],
    // 슬래시 명령 확장. 부산물로 보고 침묵시킨 판본이 있었으나 `/clean-code` 류는 뒤에 응답을 달고
    // 온다(실측 14건) — 종류를 가리지 않고 여는 이벤트를 낸다.
    [{ type: "user", timestamp: "2026-08-18T06:31:00.000Z", message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>" } }],
    // `<command-name>`이 선두가 아닌 판본. 접두 하나만 보던 규칙이 놓치던 형태다.
    [{ type: "user", timestamp: "2026-08-18T06:31:00.000Z", message: { role: "user", content: "<command-message>clean-code</command-message>\n<command-name>/clean-code</command-name>" } }],
    [{ type: "user", timestamp: "2026-08-18T06:31:00.000Z", message: { role: "user", content: "<local-command-stdout>Set model to claude-opus-5[1m]</local-command-stdout>" } }],
    [{ type: "user", timestamp: "2026-08-18T06:31:00.000Z", message: { role: "user", content: "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>" } }],
    [{ type: "user", timestamp: "2026-08-18T06:31:00.000Z", message: { role: "user", content: "<bash-input>firebase login</bash-input>" } }],
    [{ type: "user", timestamp: "2026-08-18T06:31:00.000Z", message: { role: "user", content: "<bash-stdout>To sign in to the Firebase CLI:</bash-stdout>" } }],
  ])("opens a bubbleless turn for an injected carrier %#", (line) => {
    expect(chatEventsFromTranscriptLine(JSON.stringify(line)))
      .toEqual([{ kind: "turn-start", at: Date.parse("2026-08-18T06:31:00.000Z") }]);
  });

  // 다른 세션이 보낸 메시지는 origin.kind가 "peer"지만 실측 122/122가 isMeta도 함께 달고 온다 —
  // 입구 필터가 먼저 잡으므로 origin 축에는 닿지 않는다. isMeta를 뺀 픽스처로 이 종류를 고정하면
  // 실물에 없는 경로를 검증하는 셈이 되므로, 실물 그대로 둔다.
  it("drops a peer carrier at the meta gate, before the origin axis sees it", () => {
    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      isMeta: true,
      origin: { kind: "peer" },
      promptSource: "system",
      message: { role: "user", content: "Another Claude session sent a message:\n<agent-message from=\"runC\">done</agent-message>" },
    }))).toEqual([]);
  });

  // 지목형 블랙리스트의 반쪽. 이 단언들이 깨지면 사람이 친 지시가 조용히 사라진다.
  it("keeps a human dispatch that carries no origin, an unlisted tag, or a non-typed source", () => {
    // `origin` 부재는 "사람 아님"이 아니다 — 구버전 CLI가 남긴 줄에는 이 필드가 없다.
    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      message: { role: "user", content: "context window cap을 걸고 있는 부분 확인해봐." },
    }))).toEqual([{ kind: "dispatch", text: "context window cap을 걸고 있는 부분 확인해봐." }]);

    // Quick Launch가 보낸 지시는 promptSource가 sdk이고 origin이 없다.
    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      promptSource: "sdk",
      message: { role: "user", content: "진행. ultracode" },
    }))).toEqual([{ kind: "dispatch", text: "진행. ultracode" }]);

    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      origin: { kind: "human" },
      message: { role: "user", content: "keep this one" },
    }))).toEqual([{ kind: "dispatch", text: "keep this one" }]);

    // 목록에 없는 태그로 시작하는 본문은 통과한다 — 모르는 것을 버리지 않는다.
    expect(chatEventsFromTranscriptLine(JSON.stringify({
      type: "user",
      message: { role: "user", content: "<context>\n직전 판정에 이어\n</context>" },
    }))).toEqual([{ kind: "dispatch", text: "<context>\n직전 판정에 이어\n</context>" }]);
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
  /**
   * 컴포저 덱이 `/usage` 같은 로컬 명령을 목록에 세우는 이상, 그 출력이 전사록에 서야 한다.
   * 버리면 사용자가 보는 것은 "고를 수는 있는데 아무 일도 안 하는 명령"이고, 그것은 덱이
   * 없는 것보다 나쁘다. 벤더가 이 메시지를 assistant 문면으로 규정하므로 `text`로 싣는다.
   */
  it("surfaces local slash-command output as transcript text", () => {
    expect(chatEventsFromSdkMessage({
      type: "system",
      subtype: "local_command_output",
      content: "Session cost: $1.24",
    })).toEqual([{ kind: "text", text: "Session cost: $1.24" }]);
  });

  it("drops a local command output that carries nothing to show", () => {
    expect(chatEventsFromSdkMessage({
      type: "system",
      subtype: "local_command_output",
      content: "   ",
    })).toEqual([]);
  });

  it("maps assistant messages like transcript lines", () => {
    expect(chatEventsFromSdkMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    })).toEqual([{ kind: "text", text: "hi" }]);
  });

  /**
   * 서브에이전트 프레임은 메인 원장이 아니다. SDK는 parent_tool_use_id를 달고 부모 스트림에
   * 흘리므로, 여기서 거르지 않으면 서브에이전트가 읽은 파일과 쓴 글이 호스트 턴에 한 번 더 선다.
   * 재생이 isSidechain을 버리는 것과 같은 문이다. 빈 문자열·null은 호스트 프레임이다.
   */
  it("keeps nested subagent frames off the host transcript", () => {
    expect(chatEventsFromSdkMessage({
      type: "assistant",
      parent_tool_use_id: "task-1",
      message: { content: [{ type: "text", text: "subagent report" }] },
    })).toEqual([]);
    expect(chatEventsFromSdkMessage({
      type: "assistant",
      parent_tool_use_id: "task-1",
      message: { content: [{ type: "tool_use", id: "s1", name: "Read", input: { file_path: "src/a.ts" } }] },
    })).toEqual([]);
    expect(chatEventsFromSdkMessage({
      type: "user",
      parent_tool_use_id: "task-1",
      message: { content: [{ type: "tool_result", tool_use_id: "s1", content: "file body" }] },
    })).toEqual([]);
    expect(chatEventsFromSdkMessage({
      type: "stream_event",
      parent_tool_use_id: "task-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "nested" } },
    })).toEqual([]);
    expect(chatEventsFromSdkMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "host" }] },
    })).toEqual([{ kind: "text", text: "host" }]);
    expect(chatEventsFromSdkMessage({
      type: "assistant",
      parent_tool_use_id: "",
      message: { content: [{ type: "text", text: "host" }] },
    })).toEqual([{ kind: "text", text: "host" }]);
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

  it("titles a job from the model's own tool input, not the notification's copy", () => {
    // 같은 문장의 사본이 둘이고 권위는 원본에 있다. Windows 한국어 환경에서는 알림이 실어 온
    // 사본만 ANSI 코드페이지를 지나 CJK가 깨진 채 도착하는 것이 보고됐다(2026-08-27) —
    // 아래 description이 바로 "WORLD 공간 조회"가 그 경로를 지났을 때의 모습이다.
    expect(chatEventsFromSdkMessage({
      type: "system", subtype: "task_started",
      task_id: "b2", tool_use_id: "call-2", description: "WORLD 怨듦컙 議고쉶", task_type: "local_bash",
    }, { toolTitles: new Map([["call-2", "WORLD 공간 조회"]]) }))
      .toEqual([expect.objectContaining({ kind: "job", id: "b2", title: "WORLD 공간 조회", toolUseId: "call-2" })]);
  });

  it("falls back to the notification when no tool call carries the original", () => {
    // 원본이 없는 잡도 있다(도구 호출 없이 서거나, 상한이 그 호출을 이미 밀어냈거나). 그때
    // 제목을 비우면 사본이 깨졌을 때보다 더 나쁘다 — 아는 유일한 값으로 되돌아간다.
    expect(chatEventsFromSdkMessage({
      type: "system", subtype: "task_started",
      task_id: "b3", tool_use_id: "call-3", description: "tail the log", task_type: "local_bash",
    }, { toolTitles: new Map([["call-other", "unrelated"]]) }))
      .toEqual([expect.objectContaining({ kind: "job", id: "b3", title: "tail the log" })]);

    expect(chatEventsFromSdkMessage({
      type: "system", subtype: "task_started",
      task_id: "b4", description: "no tool call at all", task_type: "local_bash",
    }, { toolTitles: new Map([["call-2", "unrelated"]]) }))
      .toEqual([expect.objectContaining({ kind: "job", id: "b4", title: "no tool call at all" })]);
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

  it("refuses to call an unrecognized outcome a success", () => {
    // 결말을 알아보지 못한 보고에 완료를 적으면, 이 원장이 고치려던 거짓 완료를 원장 자신이 그린다.
    for (const raw of [undefined, "cancelled", "", 7]) {
      const [event] = chatEventsFromSdkMessage({
        type: "system", subtype: "task_notification", task_id: "u1", ...(raw === undefined ? {} : { status: raw }),
        usage: { total_tokens: 12, tool_uses: 1, duration_ms: 900 },
      }) as readonly AgentChatStreamEvent[];
      // 끝났다는 사실과 비용은 남기되 결말은 주장하지 않는다.
      expect(event).toEqual({ kind: "job-end", id: "u1", tokens: 12, tools: 1, durationMs: 900 });
      expect("status" in (event as object)).toBe(false);
    }
  });

  it("still maps the three outcomes it does recognize", () => {
    for (const status of ["completed", "failed", "stopped"] as const) {
      expect(chatEventsFromSdkMessage({ type: "system", subtype: "task_notification", task_id: "k1", status }))
        .toEqual([{ kind: "job-end", id: "k1", status }]);
    }
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

  it("round-trips a context snapshot through the journal reader", () => {
    const event: AgentChatStreamEvent = {
      kind: "context",
      total: 69_000,
      max: 200_000,
      compactAt: 174_000,
      slices: [{ name: "Messages", tokens: 41_000 }, { name: "System tools", tokens: 18_400 }],
      memoryFiles: [{ name: "/repo/CLAUDE.md", tokens: 1_300 }],
      mcpTools: [{ name: "fleet · wiki_read", tokens: 240 }],
    };
    expect(readChatJournalEvent(JSON.stringify({ seq: 3, event }))).toEqual({ seq: 3, event });
  });

  it("drops a context snapshot that cannot name a window", () => {
    // 창 크기가 없으면 백분율이 없고, 0짜리 미터는 빈 사실이 아니라 틀린 사실이다.
    expect(readChatJournalEvent(JSON.stringify({ seq: 4, event: { kind: "context", total: 10, max: 0, slices: [] } }))).toBeNull();
    expect(readChatJournalEvent(JSON.stringify({ seq: 5, event: { kind: "context", max: 200_000, slices: [] } }))).toBeNull();
  });

  it("keeps only named slices in a context snapshot", () => {
    const parsed = readChatJournalEvent(JSON.stringify({
      seq: 6,
      event: { kind: "context", total: 100, max: 1_000, slices: [{ name: "Messages", tokens: 60 }, { tokens: 40 }, { name: "", tokens: 5 }] },
    }));
    expect(parsed?.event).toEqual({ kind: "context", total: 100, max: 1_000, slices: [{ name: "Messages", tokens: 60 }] });
  });

  it("carries the end-of-turn marker and treats anything else as start", () => {
    const read = (asOf: unknown): unknown => readChatJournalEvent(JSON.stringify({
      seq: 7,
      event: { kind: "context", total: 100, max: 1_000, slices: [], asOf },
    }))?.event;
    expect(read("end")).toMatchObject({ asOf: "end" });
    // 부재·모르는 값은 시작으로 읽는다 — 그것이 옛 저널의 뜻이고, 총량을 권위로 삼는 쪽으로
    // 오해되면 화면의 숫자가 뒤로 간다.
    expect(read("start")).not.toHaveProperty("asOf");
    expect(read(undefined)).not.toHaveProperty("asOf");
    expect(read("later")).not.toHaveProperty("asOf");
  });

  it("round-trips a live context total and drops one that cannot name a window", () => {
    const event: AgentChatStreamEvent = { kind: "context-live", total: 42_768, max: 500_000 };
    expect(readChatJournalEvent(JSON.stringify({ seq: 8, event }))).toEqual({ seq: 8, event });
    expect(readChatJournalEvent(JSON.stringify({ seq: 9, event: { kind: "context-live", total: 10, max: 0 } }))).toBeNull();
    expect(readChatJournalEvent(JSON.stringify({ seq: 10, event: { kind: "context-live", max: 500_000 } }))).toBeNull();
  });
});

describe("background job text passes the same gate as tool results", () => {
  it("normalizes and masks the task title, not just its length", () => {
    const [event] = chatEventsFromSdkMessage({
      type: "system", subtype: "task_started", task_id: "b1", task_type: "local_bash",
      description: "Deploy from /Users/someone/secret/keys with token sk-abcdefghijklmnopqrst",
    }, { cwd: "/repo" }) as readonly AgentChatStreamEvent[];
    expect(event).toEqual(expect.objectContaining({
      kind: "job",
      title: "Deploy from …/secret/keys with token sk-…",
    }));
  });

  it("relativizes a title that points inside the Operation folder", () => {
    const [event] = chatEventsFromSdkMessage({
      type: "system", subtype: "task_started", task_id: "b2", task_type: "local_bash",
      description: "Run tests under /repo/packages/core",
    }, { cwd: "/repo" }) as readonly AgentChatStreamEvent[];
    expect(event).toEqual(expect.objectContaining({ title: "Run tests under ./packages/core" }));
  });

  it("passes the workflow name and its phase titles through the same gate", () => {
    const [started] = chatEventsFromSdkMessage({
      type: "system", subtype: "task_started", task_id: "w1", task_type: "local_workflow",
      description: "audit", workflow_name: "audit /Users/someone/secret/plan",
    }, { cwd: "/repo" }) as readonly AgentChatStreamEvent[];
    expect(started).toEqual(expect.objectContaining({ who: "audit …/secret/plan" }));

    const [progress] = chatEventsFromSdkMessage({
      type: "system", subtype: "task_progress", task_id: "w1",
      workflow_progress: [{ type: "workflow_phase", index: 1, title: "scan /Users/someone/secret" }],
    }, { cwd: "/repo" }) as readonly AgentChatStreamEvent[];
    expect(progress).toEqual({ kind: "job-progress", id: "w1", stages: [{ title: "scan …/someone/secret", agents: [] }] });
  });

  it("keeps the report's line structure so markdown survives to the view", () => {
    // 보고는 칩이 아니라 본문이다 — 공백을 한 칸으로 접으면 제목·목록·코드 블록이 전부
    // 한 문단으로 뭉개져 마크다운 기호가 원문 그대로 남는다.
    const report = "## Findings\n\n- **one**: `/repo/src/a.ts`\n- two\n\n\n\nDone.";
    const [event] = chatEventsFromSdkMessage({
      type: "system", subtype: "task_notification", task_id: "a1", status: "completed", summary: report,
    }, { cwd: "/repo" }) as readonly AgentChatStreamEvent[];
    expect(event).toEqual(expect.objectContaining({
      summary: "## Findings\n\n- **one**: `./src/a.ts`\n- two\n\nDone.",
    }));
  });

  it("still masks and abbreviates inside a multi-line report", () => {
    const [event] = chatEventsFromSdkMessage({
      type: "system", subtype: "task_notification", task_id: "a2", status: "completed",
      summary: "line one\nkey sk-abcdefghijklmnopqrst\npath /Users/someone/secret/notes.md",
    }, { cwd: "/repo" }) as readonly AgentChatStreamEvent[];
    expect(event).toEqual(expect.objectContaining({
      summary: "line one\nkey sk-…\npath …/secret/notes.md",
    }));
  });

  it("keeps indentation so nested lists and fenced code survive", () => {
    const report = [
      "## Findings",
      "",
      "- top",
      "    - nested",
      "",
      "```python",
      "def main():",
      "    return 1",
      "```",
    ].join("\n");
    const [event] = chatEventsFromSdkMessage({
      type: "system", subtype: "task_notification", task_id: "a3", status: "completed", summary: report,
    }) as readonly AgentChatStreamEvent[];
    expect((event as { readonly summary?: string }).summary).toBe(report);
  });

  it("falls back to the task id when no description arrives", () => {
    expect(chatEventsFromSdkMessage({
      type: "system", subtype: "task_started", task_id: "b3", task_type: "local_bash",
    })).toEqual([expect.objectContaining({ kind: "job", id: "b3", title: "b3" })]);
  });
});

/**
 * 잡 하나를 열었을 때 읽어 오는 상세.
 *
 * 서브에이전트는 자기가 **말하기로 고른** 보고만 원장에 남긴다 — 발자국은 그 옆에서 실제로
 * 한 일을 말한다. 셸에는 아예 보고랄 것이 없고 출력이 곧 산출물이다.
 */
describe("chat job detail", () => {
  function subagentLine(entry: Record<string, unknown>): string {
    // 서브에이전트 전사록은 **전부** 사이드체인이다. 재생 경로가 이것을 버리기 때문에
    // 발자국 파서가 따로 존재한다 — 그 사실 자체가 이 테스트의 요점이다.
    return JSON.stringify({ isSidechain: true, agentId: "a1", ...entry });
  }

  it("reads a tool trail out of a sidechain transcript", () => {
    const raw = [
      subagentLine({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/workspace/a.ts" } }] },
      }),
      subagentLine({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      }),
      subagentLine({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }] },
      }),
      subagentLine({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "boom" }] },
      }),
    ].join("\n");

    const trail = chatSubagentTrailFromTranscript(raw, { cwd: "/tmp/workspace" });
    expect(trail.truncated).toBe(false);
    expect(trail.steps.map((step) => step.name)).toEqual(["Read", "Bash"]);
    expect(trail.steps[0]?.failed).toBeUndefined();
    expect(trail.steps[1]?.failed).toBe(true);
  });

  it("keeps a subagent that used no tool distinguishable from one it could not read", () => {
    // 빈 발자국과 못 읽은 것은 다른 사실이다 — 한 문장으로 뭉치면 거짓이 된다.
    const raw = subagentLine({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
    expect(chatSubagentTrailFromTranscript(raw).steps).toEqual([]);
  });

  it("drops a result whose call it never saw", () => {
    const raw = subagentLine({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "ghost", content: "x" }] },
    });
    expect(chatSubagentTrailFromTranscript(raw).steps).toEqual([]);
  });

  it("tails shell output from the end, keeping line structure", () => {
    // 로그는 줄이 곧 의미다. 여기서 접으면 읽을 수 없는 한 문단이 된다.
    const raw = Array.from({ length: 260 }, (_, index) => `line ${index}`).join("\n");
    const tail = chatShellTailFromOutput(raw);
    const lines = tail.tail.split("\n");
    expect(tail.truncated).toBe(true);
    expect(lines).toHaveLength(200);
    expect(lines.at(-1)).toBe("line 259");
    expect(lines[0]).toBe("line 60");
  });

  it("cuts the character cap from the end, so a tail stays a tail", () => {
    // 긴 JSON 한 줄을 찍는 명령에서 바로 걸린다. 앞에서 자르면 마지막 200줄 중 가장 오래된
    // 부분만 남는데, 화면은 그동안 "마지막 부분만 표시합니다"라고 말한다.
    const line = (mark: string) => mark + "x".repeat(4_000);
    const raw = [line("OLDEST-"), line("MID-"), line("A-"), line("B-"), line("C-"), line("D-"), line("NEWEST-")].join("\n");
    const tail = chatShellTailFromOutput(raw);
    expect(tail.truncated).toBe(true);
    expect(tail.tail).toContain("NEWEST-");
    expect(tail.tail).not.toContain("OLDEST-");
  });

  it("masks credentials and abbreviates paths in shell output", () => {
    const raw = "/tmp/workspace/src/app.ts:1\nAUTHORIZATION: Bearer sk-abcdefghijklmnopqrstuvwxyz012345";
    const tail = chatShellTailFromOutput(raw, { cwd: "/tmp/workspace" });
    expect(tail.tail).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    // 지웠다는 사실을 긍정으로도 못 박는다 — not.toContain 하나는 정화기가 통째로 죽어도 통과한다.
    // `sk-` 규칙이 Bearer 규칙보다 먼저 걸려 토큰 본문만 남기고 잘린다: 어느 규칙이 무는지가
    // 아니라 비밀이 살아남지 못한다는 것이 이 줄의 계약이다.
    expect(tail.tail).toContain("Bearer sk-…");
    expect(tail.tail).toContain("./src/app.ts");
    expect(tail.tail.split("\n")).toHaveLength(2);
  });
});
