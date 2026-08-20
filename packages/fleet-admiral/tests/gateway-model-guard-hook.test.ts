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
