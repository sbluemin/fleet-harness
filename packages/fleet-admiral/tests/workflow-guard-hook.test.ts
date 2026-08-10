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

function runGuard(
  toolInput: unknown,
  toolName = "Workflow",
): { readonly status: number; readonly stderr: string; readonly stdout: string } {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
}

describe("workflow-guard hook", () => {
  it("passes a full gateway modelId", () => {
    const { status } = runGuard({
      script: `agent("x", { model: "claude-gateway--codex--gpt-5.6-sol-fast[1m]", effort: "low" })`,
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

  it("blocks agentType usage in a dynamic workflow", () => {
    const { status, stderr } = runGuard({
      script: `agent("x", { agentType: "fleet:codex-gpt-5-6-sol-fast-1m-high" })`,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("agentType");
  });

  it("reads the script from scriptPath for resume-style runs", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-guard-"));
    tempDirs.push(dir);
    const scriptPath = path.join(dir, "wf.js");
    writeFileSync(scriptPath, `agent("x", { model: "claude-gateway--codex--gpt-5.6-sol-fast[1m]" })`);
    expect(runGuard({ scriptPath }).status).toBe(0);
    writeFileSync(scriptPath, `agent("x", { model: "codex--gpt-5.6-sol-fast[1m]" })`);
    expect(runGuard({ scriptPath }).status).toBe(2);
  });

  it("passes name-only saved workflows without inspection", () => {
    const { status } = runGuard({ name: "saved-workflow" });
    expect(status).toBe(0);
  });

  it("blocks an agent call with an empty options object and identifies it", () => {
    const { status, stderr, stdout } = runGuard({ script: `agent("x", {})` });
    expect(status).toBe(2);
    expect(stderr).toContain("1번째 agent() 호출");
    expect(stderr).toContain(`agent("x", {})`);
    expect(stdout).toBe("");
  });

  it("blocks an agent call without an options argument", () => {
    const { status, stderr } = runGuard({ script: `agent("x")` });
    expect(status).toBe(2);
    expect(stderr).toContain("리터럴 opts.model pin");
  });

  it("identifies the unpinned call in a mixed script", () => {
    const { status, stderr } = runGuard({
      script: `
        const pinned = agent("pinned", { model: "sonnet" });
        const unpinned = agent("unpinned", { effort: "low" });
      `,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("2번째 agent() 호출");
    expect(stderr).toContain(`agent("unpinned", { effort: "low" })`);
    expect(stderr).not.toContain(`agent("pinned", { model: "sonnet" })`);
  });

  it("passes when every call pins a lineage alias", () => {
    const { status, stdout } = runGuard({
      script: `
        agent("a", { model: "fable" });
        agent("b", { 'model': "opus" });
        agent("c", { "model": "sonnet" });
        agent("d", { model: "haiku" });
      `,
    });
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("passes when every call pins a full gateway modelId", () => {
    const { status } = runGuard({
      script: `
        agent("a", { model: "claude-gateway--codex--gpt-5.6-sol-fast[1m]" });
        agent("b", { model: "claude-gateway--cursor--grok-4.5[1m]" });
      `,
    });
    expect(status).toBe(0);
  });

  it("handles templates, nested delimiters, and nested schema objects", () => {
    const { status } = runGuard({
      script: `
        agent("x", {
          model: "sonnet",
          prompt: \`inspect \${run({ value: "nested ) quote", list: [1, (2 + 3)] })}\`,
          schema: { output: { nested: true } },
        });
      `,
    });
    expect(status).toBe(0);
  });

  it("does not count a model key nested under schema as a pin", () => {
    const { status, stderr } = runGuard({
      script: `agent("x", { schema: { model: "sonnet" } })`,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("1번째 agent() 호출");
  });

  it("ignores lookalike callees", () => {
    const { status } = runGuard({
      script: `
        subagent("x", {});
        spawnAgent("x", {});
        obj.agent("x", {});
        function agent(x) {}
        agent("real", { model: "sonnet" });
      `,
    });
    expect(status).toBe(0);
  });

  it("ignores agent call text in comments and string literals", () => {
    const { status } = runGuard({
      script: String.raw`
        // agent("comment", {})
        /* agent("block", {}) */
        const single = 'agent("single", {})';
        const double = "agent('double', {})";
        const template = \`agent("template", {})\`;
        agent("real", { model: "sonnet" });
      `,
    });
    expect(status).toBe(0);
  });

  it("keeps agentType precedence over the unpinned check", () => {
    const { status, stderr } = runGuard({
      script: `agent("x", { agentType: "fleet:example" })`,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("agentType");
    expect(stderr).not.toContain("리터럴 opts.model pin");
  });

  it("ignores an unpinned script for non-Workflow tools", () => {
    const { status } = runGuard({ script: `agent("x", {})` }, "Bash");
    expect(status).toBe(0);
  });

  it("passes an unreadable scriptPath without inspection", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-guard-"));
    tempDirs.push(dir);
    const { status } = runGuard({ scriptPath: path.join(dir, "missing.js") });
    expect(status).toBe(0);
  });

  /**
   * 값 검사는 코드 위치의 `model:`만 본다. 스크립트 전체를 정규식으로 훑으면 프롬프트 문장이나
   * 주석에 적힌 산문이 값으로 읽혀, 제대로 핀을 박은 워크플로우가 차단된다 — 하드 차단에서
   * 이 오탐은 곧 "정상 스크립트를 못 돌린다"가 된다.
   */
  it("reads model pins as code, not as prose inside prompts and comments", () => {
    expect(runGuard({
      script: 'await agent(`Report which model: "gpt-4" was used.`, { model: "opus" })',
    }).status).toBe(0);

    expect(runGuard({
      script: '// always pin a model: "sonnet-x" style id\nawait agent("x", { model: "opus" })',
    }).status).toBe(0);

    expect(runGuard({
      script: 'const hint = "model: \\"x\\""; await agent("x", { model: "opus" })',
    }).status).toBe(0);

    // 스키마가 우연히 model이라는 속성을 담아도 그것은 이 워크플로우의 핀이 아니다.
    expect(runGuard({
      script: 'await agent("x", { model: "opus", schema: { properties: { model: { type: "string" } } } })',
    }).status).toBe(0);
  });

  // 산문을 걸러 내면서도 검사의 사정거리는 좁히지 않는다 — 헬퍼 객체에 잘못 박힌 값도 그대로 잡는다.
  it("still rejects a bad value wherever the code puts it", () => {
    const helper = runGuard({
      script: 'const OPTS = { model: "nope" };\nawait agent("x", { model: "opus" })',
    });
    expect(helper.status).toBe(2);
    expect(helper.stderr).toContain("nope");

    const quoted = runGuard({ script: 'await agent("x", { "model": "sol-fast" })' });
    expect(quoted.status).toBe(2);
    expect(quoted.stderr).toContain("sol-fast");
  });

  /**
   * 정규식 리터럴 안의 괄호는 코드의 괄호가 아니다. 이것을 세면 `agent(` 의 인수 경계를 못 찾아,
   * 제대로 핀을 박은 워크플로우가 "핀이 없다"며 하드 차단된다 — 가드가 막아야 할 것을 막는 대신
   * 정상 실행을 막는 쪽이 훨씬 나쁘다.
   */
  it("reads regex literals as literals, not as stray delimiters", () => {
    expect(runGuard({
      script: 'const clean = (s) => s.replace(/[)}]/g, "");\nawait agent("x", { model: "opus" })',
    }).status).toBe(0);

    // 문자 클래스 안의 닫는 괄호가 실제 경계로 읽히면, 이 호출의 인수 범위 자체를 잃는다.
    expect(runGuard({
      script: 'await agent("x", { model: "opus", label: name.replace(/[)\\]]/g, "") })',
    }).status).toBe(0);

    // 정규식 안의 따옴표도 문자열을 열지 않는다.
    expect(runGuard({
      script: 'const q = /["\'`]/g;\nawait agent("x", { model: "opus" })',
    }).status).toBe(0);

    // 나눗셈은 나눗셈으로 남아야 한다 — 정규식으로 오인하면 뒤의 코드를 통째로 삼킨다.
    expect(runGuard({
      script: 'const half = total / 2;\nawait agent("x", { schema: S })',
    }).status).toBe(2);
  });

  it("blocks an unpinned script loaded from scriptPath", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-guard-"));
    tempDirs.push(dir);
    const scriptPath = path.join(dir, "unpinned.js");
    writeFileSync(scriptPath, `agent("from-file", { schema: S })`);
    const { status, stderr } = runGuard({ scriptPath });
    expect(status).toBe(2);
    expect(stderr).toContain(`agent("from-file", { schema: S })`);
  });
});
