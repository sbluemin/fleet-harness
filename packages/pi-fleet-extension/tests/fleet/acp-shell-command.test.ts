import { describe, expect, it } from "vitest";

import { buildBridgeCommand } from "../../src/bridge/command.js";

describe("acp-shell command", () => {
  it("Codex resume 전에 archived rollout을 sessions 경로로 복원한다", () => {
    const spec = buildBridgeCommand({
      cli: "codex",
      cwd: "/tmp/project",
      sessionId: "019dc235-e9a5-78a3-ab26-6653be26ac17",
      model: "gpt-5.4",
      effort: "high",
    });

    expect(spec.command).toContain("find \"$HOME/.codex/archived_sessions\"");
    expect(spec.command).toContain("-name 'rollout-*-019dc235-e9a5-78a3-ab26-6653be26ac17.jsonl'");
    expect(spec.command).toContain("\"$HOME/.codex/sessions/$__fleet_codex_year/$__fleet_codex_month/$__fleet_codex_day/$__fleet_codex_base\"");
    expect(spec.command).toContain("cp \"$__fleet_codex_archived\" \"$__fleet_codex_target\"");
    expect(spec.command).toContain("; codex --full-auto resume '019dc235-e9a5-78a3-ab26-6653be26ac17' -m 'gpt-5.4' -c 'model_reasoning_effort=\"high\"'");
    expect(spec.cwd).toBe("/tmp/project");
  });

  it("Codex 신규 실행에는 archived restore prelude를 붙이지 않는다", () => {
    const spec = buildBridgeCommand({
      cli: "codex",
      cwd: "/tmp/project",
      sessionId: "",
      model: "gpt-5.4",
    });

    expect(spec.command).toBe("codex --full-auto -m 'gpt-5.4'");
  });

  it("Claude와 Gemini resume 명령은 변경하지 않는다", () => {
    const claude = buildBridgeCommand({
      cli: "claude",
      cwd: "/tmp/project",
      sessionId: "claude-session",
      model: "opus",
      effort: "high",
    });
    const gemini = buildBridgeCommand({
      cli: "gemini",
      cwd: "/tmp/project",
      sessionId: "gemini-session",
      model: "gemini-2.5-flash",
    });

    expect(claude.command).toBe("claude --dangerously-skip-permissions --resume 'claude-session' --model 'opus' --effort 'high'");
    expect(gemini.command).toBe("gemini --yolo --resume 'gemini-session' --model 'gemini-2.5-flash'");
  });
});
