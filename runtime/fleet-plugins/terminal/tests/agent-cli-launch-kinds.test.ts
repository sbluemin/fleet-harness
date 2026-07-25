import { describe, expect, it } from "vitest";

import { buildAgentCliLaunchKinds } from "../server/agent-api/agent-cli-launch-kinds.js";

describe("buildAgentCliLaunchKinds", () => {
  it("모든 CLI를 Operation Controls 목록에 포함한다", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude", label: "Claude", available: true, signedIn: true },
        { id: "claude-kimi", label: "Kimi (Claude Code)", available: true, signedIn: true },
        { id: "codex", label: "Codex", available: true, signedIn: true },
      ],
      "agent",
    );

    expect(result).toEqual([
      { id: "claude", type: "agent", title: "Claude", supportsInitialPrompt: true },
      { id: "claude-kimi", type: "agent", title: "Kimi (Claude Code)", supportsInitialPrompt: true },
      { id: "codex", type: "agent", title: "Codex", supportsInitialPrompt: true },
    ]);
  });

  it("설치 미완료 및 로그인 미완료 CLI에 비활성화 사유를 표시한다", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude", label: "Claude", available: false, signedIn: true },
        { id: "claude-kimi", label: "Kimi (Claude Code)", available: true, signedIn: false },
        { id: "codex", label: "Codex", available: true, signedIn: false },
      ],
      "agent",
    );

    expect(result).toEqual([
      { id: "claude", type: "agent", title: "Claude", supportsInitialPrompt: true, disabled: true, disabledReason: "Not installed" },
      { id: "claude-kimi", type: "agent", title: "Kimi (Claude Code)", supportsInitialPrompt: true, disabled: true, disabledReason: "Sign in required" },
      { id: "codex", type: "agent", title: "Codex", supportsInitialPrompt: true, disabled: true, disabledReason: "Sign in required" },
    ]);
  });
});
