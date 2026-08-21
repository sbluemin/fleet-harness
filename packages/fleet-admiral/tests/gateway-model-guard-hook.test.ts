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
  // 이 세션은 Fleet 시스템 프롬프트를 싣지 않는다. 매 턴 주입은 세부 핀 규약 대신
  // 위임·병렬 작업을 온디맨드 orchestration 스킬로 라우팅하는 트립와이어만 맡는다.
  it("routes delegated and parallel work through orchestration on every turn", () => {
    const { status, stdout } = run("remind", {});
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("delegation or a parallel workload");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("fleet:orchestration");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("before calling Agent or Workflow");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("completion supplies the live routing context");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Do not delegate implementation by default");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("opts.model");
  });

  // 주입은 stdin과 무관하게 성립해야 한다. 턴 시작 payload 모양이 바뀌어도 라우팅 트립와이어는 실려야 한다.
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
      expect(stderr, subagentType).toContain("fleet:orchestration");
      expect(stderr, subagentType).toContain("live routing context");
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

  // 핀 인식은 콜론 앞 공백을 허용한다. 값 검증만 놓치면 핀으로 세어진 스테이지가 검사 없이 나간다.
  it("validates a model value written with whitespace before the colon", () => {
    const { status, stderr } = gateWorkflow({ script: `agent("x", { model : "codex--gpt-5.6-sol-fast" })` });
    expect(status).toBe(2);
    expect(stderr).toContain("claude-gateway--");
  });

  // 값 검증이 핀 인식보다 넓으면 `response_model` 같은 설정 키가 opts.model로 오인된다.
  it("does not read a suffixed configuration key as a stage pin", () => {
    for (const script of [
      `const cfg = { response_model : "compact" }; agent(cfg.response_model, { model: "opus" })`,
      `const cfg = { response_model: "compact" }; agent(cfg.response_model, { model: "opus" })`,
    ]) {
      expect(gateWorkflow({ script }).status, script).toBe(0);
    }
  });

  it("blocks a lineage alias that carries the gateway prefix", () => {
    const { status, stderr } = gateWorkflow({ script: `agent("x", { model: "claude-gateway--fable" })` });
    expect(status).toBe(2);
    expect(stderr).toContain("prefix");
  });

  // 틀린 핀을 막는 것만으로는 부족하다 — 아예 핀하지 않은 스테이지가 세션 모델을 상속한다.
  it("blocks a stage that pins no model at all", () => {
    for (const script of [`agent("x")`, `agent("x", { schema: S })`, `const r = await agent(prompt, {})`]) {
      const { status, stderr } = gateWorkflow({ script });
      expect(status, script).toBe(2);
      expect(stderr, script).toContain("model");
    }
  });

  it("counts every unpinned stage in one script", () => {
    const { status, stderr } = gateWorkflow({
      script: [
        `const a = await agent("one", { model: "claude-gateway--xai--grok-4.6" })`,
        `const b = await agent("two", { schema: S })`,
        `const c = await agent("three")`,
      ].join("\n"),
    });
    expect(status).toBe(2);
    expect(stderr).toContain("2 agent() call(s)");
  });

  // 프롬프트 텍스트의 괄호를 호출 경계로 세면 멀쩡한 스크립트가 막힌다.
  it("reads call boundaries past parentheses and quotes inside the prompt", () => {
    const { status } = gateWorkflow({
      script: `await agent("check foo(bar) and \\"baz)\\" here", { model: "claude-gateway--xai--grok-4.6" })`,
    });
    expect(status).toBe(0);
  });

  it("blocks agentType usage in a dynamic workflow", () => {
    const { status, stderr } = gateWorkflow({
      script: `agent("x", { agentType: "fleet:codex-gpt-5-6-sol-fast-high" })`,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("agentType");
  });

  it("does not read a suffixed identifier as opts.agentType", () => {
    const script = `const cfg = { subagentType: "helper" }; agent("x", { model: "opus" })`;
    expect(gateWorkflow({ script }).status).toBe(0);
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

describe("gateway model guard — orchestration failure", () => {
  it("states that a failed orchestration supplied no routing context", () => {
    const { status, stdout } = run("orchestration-failed", {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Skill",
      tool_input: { skill: "fleet:orchestration" },
      error: "skill failed",
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUseFailure");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("no live routing context was supplied");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("do not guess an identity");
  });

  it("ignores another failed skill", () => {
    expect(run("orchestration-failed", {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Skill",
      tool_input: { skill: "fleet:professional-pushback" },
      error: "skill failed",
    }).stdout).toBe("");
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
