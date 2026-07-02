import { describe, expect, it } from "vitest";

import { buildAgentCliLaunchKinds } from "../server/agent-api/agent-cli-launch-kinds.js";

describe("buildAgentCliLaunchKinds", () => {
  it("Claude Kimi와 Claude GLM을 Operation Controls 목록에서 숨긴다", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude", label: "Claude", available: true, signedIn: true },
        { id: "claude-kimi", label: "Claude Kimi", available: true, signedIn: true },
        { id: "claude-glm", label: "Claude GLM", available: true, signedIn: true },
        { id: "codex", label: "Codex", available: true, signedIn: true },
      ],
      "agent",
    );

    expect(result).toEqual([
      { id: "claude", type: "agent", title: "Claude" },
      { id: "codex", type: "agent", title: "Codex" },
    ]);
  });

  it("지원되는 CLI에는 기존 설치와 로그인 비활성화 사유를 유지한다", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude", label: "Claude", available: false, signedIn: true },
        { id: "codex", label: "Codex", available: true, signedIn: false },
      ],
      "agent",
    );

    expect(result).toEqual([
      { id: "claude", type: "agent", title: "Claude", disabled: true, disabledReason: "Not installed" },
      { id: "codex", type: "agent", title: "Codex", disabled: true, disabledReason: "Sign in required" },
    ]);
  });
});
