import { describe, expect, it } from "vitest";

import { buildAgentCliLaunchKinds } from "../server/agent-api/agent-cli-launch-kinds.js";

describe("buildAgentCliLaunchKinds", () => {
  it("지원되는 Claude CLI만 Operation Controls 목록에 포함한다", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude-native", label: "Claude (Native)", available: true, signedIn: true },
        { id: "claude-gateway", label: "Claude (Gateway)", available: true, signedIn: true },
      ],
      "agent",
    );

    expect(result).toEqual([
      { id: "claude-native", type: "agent", title: "Claude (Native)" },
      { id: "claude-gateway", type: "agent", title: "Claude (Gateway)" },
    ]);
  });

  it("설치 미완료 및 로그인 미완료 CLI에 비활성화 사유를 표시한다", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude-gateway", label: "Claude (Gateway)", available: false, signedIn: true },
        { id: "claude-native", label: "Claude (Native)", available: true, signedIn: false },
      ],
      "agent",
    );

    expect(result).toEqual([
      { id: "claude-gateway", type: "agent", title: "Claude (Gateway)", disabled: true, disabledReason: "Not installed" },
      { id: "claude-native", type: "agent", title: "Claude (Native)", disabled: true, disabledReason: "Sign in required" },
    ]);
  });
});
