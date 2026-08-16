import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

// 실제 훅 스크립트(임베드 자산 소스)를 stdin 픽스처로 스폰해 검증한다 — 렌더된 hooks.json이
// 참조하는 그 파일 그대로이므로, 로직만 단위 테스트하는 것보다 진짜 계약에 가깝다.
const GUARD_SCRIPT = fileURLToPath(new URL("../assets/hooks/workflow-guard.mjs", import.meta.url));

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runGuard(toolInput: unknown): { readonly status: number; readonly stderr: string } {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT], {
    input: JSON.stringify({ tool_name: "Workflow", tool_input: toolInput }),
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stderr: result.stderr };
}

function runGuardEvent(payload: Record<string, unknown>): { readonly status: number; readonly stdout: string } {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stdout: result.stdout };
}

describe("workflow-guard hook", () => {
  it("passes a full gateway modelId", () => {
    const { status } = runGuard({
      script: `agent("x", { model: "claude-gateway--codex--gpt-5.6-sol-fast", effort: "low" })`,
    });
    expect(status).toBe(0);
  });

  it("passes lineage aliases without the gateway prefix", () => {
    for (const alias of ["fable", "opus", "sonnet", "haiku"]) {
      const { status } = runGuard({ script: `agent("x", { model: "${alias}" })` });
      expect(status, alias).toBe(0);
    }
  });

  it("blocks a model value that dropped the claude-gateway-- prefix", () => {
    const { status, stderr } = runGuard({ script: `agent("x", { model: "codex--gpt-5.6-sol-fast[1m]" })` });
    expect(status).toBe(2);
    expect(stderr).toContain("claude-gateway--");
  });

  it("blocks a lineage alias that carries the gateway prefix", () => {
    const { status, stderr } = runGuard({ script: `agent("x", { model: "claude-gateway--fable" })` });
    expect(status).toBe(2);
    expect(stderr).toContain("prefix");
  });

  // 디스패치 직후의 계약. 차단이 아니라 문맥 추가이므로 통과 상태로 끝나야 하고, 툴 출력을
  // 바꾸지 않는다 — run id는 그대로 모델에게 간다.
  it("tells the model the dispatch returned a receipt, without touching the tool output", () => {
    const { status, stdout } = runGuardEvent({
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

  // PostToolUse 분기가 스크립트 검증보다 앞에 서야 한다 — 뒤에 서면 이미 통과한 디스패치의
  // 스크립트를 한 번 더 검사하다 실패해 turn 이 오류로 물든다.
  it("adds the in-flight context even for a dispatch that carried no inspectable script", () => {
    const { status, stdout } = runGuardEvent({
      hook_event_name: "PostToolUse",
      tool_name: "Workflow",
      tool_input: { name: "saved-workflow" },
    });
    expect(status).toBe(0);
    expect(stdout).toContain("still in flight");
  });

  it("blocks agentType usage in a dynamic workflow", () => {
    const { status, stderr } = runGuard({
      script: `agent("x", { agentType: "fleet:codex-gpt-5-6-sol-fast-high" })`,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("agentType");
  });

  it("reads the script from scriptPath for resume-style runs", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-guard-"));
    tempDirs.push(dir);
    const scriptPath = path.join(dir, "wf.js");
    writeFileSync(scriptPath, `agent("x", { model: "claude-gateway--codex--gpt-5.6-sol-fast" })`);
    expect(runGuard({ scriptPath }).status).toBe(0);
    writeFileSync(scriptPath, `agent("x", { model: "codex--gpt-5.6-sol-fast[1m]" })`);
    expect(runGuard({ scriptPath }).status).toBe(2);
  });

  it("passes name-only saved workflows without inspection", () => {
    const { status } = runGuard({ name: "saved-workflow" });
    expect(status).toBe(0);
  });

  it("ignores non-Workflow tools", () => {
    const result = spawnSync(process.execPath, [GUARD_SCRIPT], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  });
});
