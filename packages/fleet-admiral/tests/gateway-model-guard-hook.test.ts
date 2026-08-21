import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

// 실제 훅 스크립트(임베드 자산 소스)를 stdin 픽스처로 스폰해 검증한다 — 렌더된 hooks.json이
// 참조하는 그 파일 그대로이므로, 로직만 단위 테스트하는 것보다 진짜 계약에 가깝다.
const GUARD_SCRIPT = fileURLToPath(new URL("../assets/hooks/fleet-gateway-model-guard.mjs", import.meta.url));

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(subcommand: string, payload: unknown): {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
} {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT, subcommand], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
}

function gateWorkflow(toolInput: unknown) {
  return run("gate-delegation", { tool_name: "Workflow", tool_input: toolInput });
}

function gateAgent(toolInput: unknown) {
  return run("gate-delegation", { tool_name: "Agent", tool_input: toolInput });
}

describe("gateway model guard — remind", () => {
  // 이 세션은 Fleet 시스템 프롬프트를 싣지 않는다. 위임 규약이 모델에 닿는 경로는 이 주입뿐이다.
  it("injects the pin contract on every turn", () => {
    const { status, stdout } = run("remind", {});
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("gateway_models");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("subagent_type");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("opts.model");
    // 핀이 선택이 된 뒤에도 로스터 조회는 핀의 조건이다 — 기억한 이름은 여전히 해석된다는
    // 증거가 아니다. 워크플로우 스테이지의 두 핀 철자가 그 조회에 함께 묶여 있어야 한다.
    expect(parsed.hookSpecificOutput.additionalContext).toContain("opts.agentType");
    // 조회는 무조건이고 핀은 표면마다 조건이 붙는다. 한 문단에 섞으면 핀 쪽 면제가 조회의
    // 무조건성까지 조건부로 물들이므로, 주입문은 조회를 먼저 끝내고 핀 철자를 뒤에서 말한다.
    expect(parsed.hookSpecificOutput.additionalContext).toContain("every time, not once per session");
  });

  // 주입은 stdin과 무관하게 성립해야 한다. 턴 시작 payload 모양이 바뀌어도 규약은 실려야 한다.
  it("does not depend on the hook payload", () => {
    expect(run("remind", { hook_event_name: "UserPromptSubmit", prompt: "hello" }).status).toBe(0);
  });
});

describe("gateway model guard — Agent delegation", () => {
  it("passes a pinned gateway identity", () => {
    expect(gateAgent({ subagent_type: "fleet:xai-grok-4-6-low" }).status).toBe(0);
  });

  it("blocks the unpinned spellings", () => {
    for (const subagentType of ["general-purpose", "claude"]) {
      const { status, stderr } = gateAgent({ subagent_type: subagentType });
      expect(status, subagentType).toBe(2);
      expect(stderr, subagentType).toContain("gateway_models");
    }
  });

  it("blocks a delegation that names no agent type at all", () => {
    const { status, stderr } = gateAgent({ prompt: "do it" });
    expect(status).toBe(2);
    expect(stderr).toContain("subagent_type");
  });

  // 내장 전문 에이전트와 fork는 그 도구를 쓰려고 고른 이름이지 위임을 미룬 결과가 아니다.
  // fork는 부모 컨텍스트를 잇는 것이 목적이라 다른 모델로 옮기면 그 표면의 의미가 사라진다.
  it("passes built-in specialist types and fork", () => {
    for (const subagentType of ["fork", "Explore", "Plan", "claude-code-guide", "statusline-setup"]) {
      expect(gateAgent({ subagent_type: subagentType }).status, subagentType).toBe(0);
    }
  });
});

describe("gateway model guard — Workflow delegation", () => {
  it("passes a full gateway modelId", () => {
    const { status } = gateWorkflow({
      script: `agent("x", { model: "claude-gateway--codex--gpt-5.6-sol-fast", effort: "low" })`,
    });
    expect(status).toBe(0);
  });

  it("passes lineage aliases without the gateway prefix", () => {
    for (const alias of ["fable", "opus", "sonnet", "haiku"]) {
      const { status } = gateWorkflow({ script: `agent("x", { model: "${alias}" })` });
      expect(status, alias).toBe(0);
    }
  });

  it("blocks a model value that dropped the claude-gateway-- prefix", () => {
    const { status, stderr } = gateWorkflow({ script: `agent("x", { model: "codex--gpt-5.6-sol-fast[1m]" })` });
    expect(status).toBe(2);
    expect(stderr).toContain("claude-gateway--");
  });

  it("blocks a lineage alias that carries the gateway prefix", () => {
    const { status, stderr } = gateWorkflow({ script: `agent("x", { model: "claude-gateway--fable" })` });
    expect(status).toBe(2);
    expect(stderr).toContain("prefix");
  });

  // 핀하지 않은 스테이지는 세션 모델로 돈다. 스테이지를 옮길지 말지는 작업을 읽어야 나오는
  // 판단이라 훅이 볼 수 없다 — 요구하면 한 값으로 전부 채우는 순응만 남는다.
  it("passes a stage that pins no model at all", () => {
    for (const script of [`agent("x")`, `agent("x", { schema: S })`, `const r = await agent(prompt, {})`]) {
      expect(gateWorkflow({ script }).status, script).toBe(0);
    }
  });

  it("passes a script that mixes pinned and unpinned stages", () => {
    const { status } = gateWorkflow({
      script: [
        `const a = await agent("one", { model: "claude-gateway--xai--grok-4.6" })`,
        `const b = await agent("two", { schema: S })`,
        `const c = await agent("three")`,
      ].join("\n"),
    });
    expect(status).toBe(0);
  });

  // agentType은 스테이지의 또 다른 정당한 핀이다. 내장 타입도 그 자리의 정당한 값이므로
  // fleet: 접두를 요구하지 않는다.
  it("passes agentType usage in a dynamic workflow", () => {
    for (const value of ["fleet:xai-grok-4-6-low", "general-purpose", "code-reviewer"]) {
      expect(gateWorkflow({ script: `agent("x", { agentType: "${value}" })` }).status, value).toBe(0);
    }
  });

  // 콜론 앞 공백도 유효한 프로퍼티 표기다. 정규 표기만 아는 검사는 그 한 칸으로 비켜간다.
  it("reads a property written with whitespace before the colon", () => {
    for (const script of [
      `agent("x", { agentType : "claude-gateway--codex--gpt-5.6-sol-fast" })`,
      `agent("x", { model : "codex--gpt-5.6-sol-fast" })`,
    ]) {
      expect(gateWorkflow({ script }).status, script).toBe(2);
    }
  });

  // 두 철자를 맞바꾼 나머지 절반. modelId는 어떤 레지스트리에도 이름으로 없어 반드시 죽는다.
  it("blocks a modelId written into the agentType slot", () => {
    const { status, stderr } = gateWorkflow({
      script: `agent("x", { agentType: "claude-gateway--codex--gpt-5.6-sol-fast" })`,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("opts.model");
  });

  // 로스터 이름이 model 자리에 들어가면 전 분기가 디스패치 즉시 죽는다. 그 실패만 미리 잡는다.
  it("blocks a roster identity name written into the model slot", () => {
    const { status, stderr } = gateWorkflow({ script: `agent("x", { model: "fleet:xai-grok-4-6-low" })` });
    expect(status).toBe(2);
    expect(stderr).toContain("agentType");
  });

  it("reads the script from scriptPath for resume-style runs", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gateway-model-guard-"));
    tempDirs.push(dir);
    const scriptPath = path.join(dir, "wf.js");
    writeFileSync(scriptPath, `agent("x", { model: "claude-gateway--codex--gpt-5.6-sol-fast" })`);
    expect(gateWorkflow({ scriptPath }).status).toBe(0);
    writeFileSync(scriptPath, `agent("x", { model: "codex--gpt-5.6-sol-fast[1m]" })`);
    expect(gateWorkflow({ scriptPath }).status).toBe(2);
  });

  it("passes name-only saved workflows without inspection", () => {
    expect(gateWorkflow({ name: "saved-workflow" }).status).toBe(0);
  });

  it("ignores tools it does not gate", () => {
    expect(run("gate-delegation", { tool_name: "Bash", tool_input: { command: "ls" } }).status).toBe(0);
  });
});

describe("gateway model guard — workflow receipt", () => {
  // 디스패치 직후의 계약. 차단이 아니라 문맥 추가이므로 통과 상태로 끝나야 하고, 툴 출력을
  // 바꾸지 않는다 — run id는 그대로 모델에게 간다.
  it("tells the model the dispatch returned a receipt, without touching the tool output", () => {
    const { status, stdout } = run("workflow-receipt", {
      hook_event_name: "PostToolUse",
      tool_name: "Workflow",
      tool_input: { script: `agent("x", { model: "opus" })` },
      tool_response: { runId: "wf_abc123" },
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string; updatedToolOutput?: unknown };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("receipt, not a result");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("one status line");
    expect("updatedToolOutput" in parsed.hookSpecificOutput).toBe(false);
  });

  // 접수증 계약은 스크립트 검증과 독립이어야 한다 — 이미 통과한 디스패치를 한 번 더 검사하다
  // 실패하면 turn이 오류로 물든다.
  it("adds the in-flight context even for a dispatch that carried no inspectable script", () => {
    const { status, stdout } = run("workflow-receipt", {
      hook_event_name: "PostToolUse",
      tool_name: "Workflow",
      tool_input: { name: "saved-workflow" },
    });
    expect(status).toBe(0);
    expect(stdout).toContain("still in flight");
  });
});

describe("gateway model guard — roster lookup", () => {
  // 트랜스크립트는 하네스가 쓰는 그 파일이다. 훅이 따로 만드는 상태 파일이 아니므로 신선도와
  // 정리를 떠안지 않는다 — 픽스처도 같은 모양으로 만든다.
  function transcript(lines: readonly unknown[]): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gateway-model-guard-transcript-"));
    tempDirs.push(dir);
    const transcriptPath = path.join(dir, "session.jsonl");
    writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"));
    return transcriptPath;
  }

  function lookupCall(toolName = "mcp__fleet__gateway_models", extra: Record<string, unknown> = {}) {
    return {
      type: "assistant",
      ...extra,
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: toolName, input: {} }] },
    };
  }

  // 매 턴 주입되는 규약문에는 `gateway_models`가 그대로 들어 있다. 도구 목록과 사용자 프롬프트도
  // 마찬가지다. 문자열이 보인다는 사실은 호출의 증거가 아니다.
  const MENTION_WITHOUT_CALL = [
    {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "왜 gateway_models 없이 팬아웃하지?" }] },
    },
    {
      type: "system",
      attachment: { type: "hook_additional_context", content: ["Call gateway_models before any Agent or Workflow run"] },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_0", name: "ToolSearch", input: { query: "select:mcp__fleet__gateway_models" } }],
      },
    },
  ];

  function gateAgentWith(transcriptPath: string, subagentType: string) {
    return run("gate-delegation", {
      tool_name: "Agent",
      transcript_path: transcriptPath,
      tool_input: { subagent_type: subagentType },
    });
  }

  function gateWorkflowWith(transcriptPath: string, toolInput: unknown) {
    return run("gate-delegation", { tool_name: "Workflow", transcript_path: transcriptPath, tool_input: toolInput });
  }

  it("passes a gateway delegation once the session has read the roster", () => {
    const transcriptPath = transcript([lookupCall()]);
    expect(gateAgentWith(transcriptPath, "fleet:xai-grok-4-6-low").status).toBe(0);
    expect(gateWorkflowWith(transcriptPath, { script: `agent("x")` }).status).toBe(0);
  });

  // 이 게이트가 존재하는 이유. 철자만 보면 기억한 이름이 통과하고, 규약은 지켜졌다는 외양만 남는다.
  it("blocks a fan-out from a session that never called gateway_models", () => {
    const transcriptPath = transcript(MENTION_WITHOUT_CALL);
    const agent = gateAgentWith(transcriptPath, "fleet:xai-grok-4-6-low");
    expect(agent.status).toBe(2);
    expect(agent.stderr).toContain("gateway_models");

    const workflow = gateWorkflowWith(transcriptPath, { script: `agent("x")` });
    expect(workflow.status).toBe(2);
    expect(workflow.stderr).toContain("gateway_models");
  });

  // 스테이지를 하나도 옮기지 않는 워크플로우도 호스트를 떠나는 팬아웃이다. 옮길지 말지를
  // 판단하려면 그 재료인 로스터를 먼저 읽어야 한다.
  it("blocks an unread-roster Workflow whichever form the dispatch takes", () => {
    const transcriptPath = transcript(MENTION_WITHOUT_CALL);
    for (const toolInput of [{ script: `agent("x")` }, { name: "saved-workflow" }, { scriptPath: "/tmp/absent.js" }]) {
      expect(gateWorkflowWith(transcriptPath, toolInput).status, JSON.stringify(toolInput)).toBe(2);
    }
  });

  // 서브에이전트가 읽은 로스터는 호스트의 조회가 아니다. 위임을 결정하는 것은 호스트다.
  it("does not count a lookup made inside a subagent", () => {
    const transcriptPath = transcript([lookupCall("mcp__fleet__gateway_models", { isSidechain: true })]);
    expect(gateAgentWith(transcriptPath, "fleet:xai-grok-4-6-low").status).toBe(2);
  });

  // MCP 서버 등록명은 바뀔 수 있다. 접두를 하드코딩하면 그날 게이트가 조용히 전부 통과시킨다.
  it("recognises the lookup under any MCP server prefix", () => {
    for (const toolName of ["gateway_models", "mcp__fleet__gateway_models", "mcp__fleet-console__gateway_models"]) {
      const transcriptPath = transcript([lookupCall(toolName)]);
      expect(gateAgentWith(transcriptPath, "fleet:xai-grok-4-6-low").status, toolName).toBe(0);
    }
  });

  // 내장 타입은 호스트 모델로 도는 도구 선택이라 로스터에 걸린 것이 없다.
  it("does not demand a lookup for built-in agent types", () => {
    const transcriptPath = transcript(MENTION_WITHOUT_CALL);
    for (const subagentType of ["Explore", "Plan", "fork"]) {
      expect(gateAgentWith(transcriptPath, subagentType).status, subagentType).toBe(0);
    }
  });

  // 근거가 없으면 닫지 않는다. 훅이 이 필드를 받지 못하는 경로가 생겼을 때 모든 위임이 막히는
  // 쪽이, 조회 한 번을 놓치는 쪽보다 훨씬 나쁘다.
  it("stays open when the transcript cannot be read", () => {
    expect(gateAgent({ subagent_type: "fleet:xai-grok-4-6-low" }).status).toBe(0);
    expect(gateWorkflowWith("/nonexistent/session.jsonl", { script: `agent("x")` }).status).toBe(0);
    expect(gateWorkflowWith("", { script: `agent("x")` }).status).toBe(0);
  });

  // 조회를 마친 세션에서도 철자 검사는 그대로다. 두 판정은 독립이다.
  it("still judges spelling after the roster was read", () => {
    const transcriptPath = transcript([lookupCall()]);
    const { status, stderr } = gateWorkflowWith(transcriptPath, {
      script: `agent("x", { model: "codex--gpt-5.6-sol-fast" })`,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("claude-gateway--");
  });
});
