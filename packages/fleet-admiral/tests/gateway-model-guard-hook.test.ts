import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// 실제 훅 스크립트(임베드 자산 소스)를 stdin 픽스처로 스폰해 검증한다 — 렌더된 hooks.json이
// 참조하는 그 파일 그대로이므로, 로직만 단위 테스트하는 것보다 진짜 계약에 가깝다.
const GUARD_SCRIPT = fileURLToPath(new URL("../assets/hooks/fleet-gateway-model-guard.mjs", import.meta.url));

function run(subcommand: string, payload: unknown, args: readonly string[] = []): {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
} {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT, subcommand, ...args], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
}

describe("gateway model guard — plugin version", () => {
  it("reports the rendered Fleet plugin version as SessionStart context", () => {
    const { status, stdout } = run("plugin-version", {}, ["1.72.3"]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "Fleet plugin version: 1.72.3",
      },
    });
  });
});

describe("gateway model guard — retired subcommands", () => {
  // 위임 라우팅은 delegation 스킬 description이, 디스패치별 정체성 선택은 스킬 본문이 소유한다.
  // 공유 플러그인 트리는 in-place 교체라 실행 중 세션이 다음 이벤트부터 이 스크립트를 실행하므로,
  // 낡은 hooks.json이 옛 서브커맨드를 물려도 판정 없이 통과해야 한다 — 특히 gate-delegation은
  // 핀 없는 디스패치를 물고 들어와도 차단(exit 2)하면 안 된다.
  it.each([
    ["remind", { hook_event_name: "UserPromptSubmit", prompt: "hello" }],
    ["gate-delegation", { tool_name: "Agent", tool_input: { subagent_type: "general-purpose" } }],
    ["gate-delegation", { tool_name: "Workflow", tool_input: { script: `agent("x", { agentType: "helper" })` } }],
  ] as const)("passes retired subcommand %s without judging or blocking", (subcommand, payload) => {
    const { status, stdout, stderr } = run(subcommand, payload);
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
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

  // 접수증 계약은 디스패치 형태와 독립이어야 한다 — 스크립트가 없는 저장 워크플로우 호출에도 실린다.
  it("adds the in-flight context even for a dispatch that carried no inspectable script", () => {
    const { status, stdout } = run("workflow-receipt", {
      hook_event_name: "PostToolUse",
      tool_name: "Workflow",
      tool_input: { name: "saved-workflow" },
    });
    expect(status).toBe(0);
    expect(stdout).toContain("still in flight");
  });

  it("ignores tools it does not annotate", () => {
    expect(run("workflow-receipt", { tool_name: "Bash", tool_input: { command: "ls" } }).status).toBe(0);
  });
});
