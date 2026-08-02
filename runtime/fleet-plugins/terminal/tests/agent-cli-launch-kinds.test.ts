import { describe, expect, it } from "vitest";

import { buildAgentCliLaunchKinds } from "../server/agent-api/agent-cli-launch-kinds.js";

describe("buildAgentCliLaunchKinds", () => {
  it("지원되는 Claude CLI만 Operation Controls 목록에 포함한다", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude-native", label: "Claude (Native)", available: true, signedIn: true },
        { id: "claude", label: "Claude", available: true, signedIn: true },
        { id: "claude-gateway", label: "Claude (Gateway • Experimental)", available: true, signedIn: true },
      ],
      "agent",
    );

    expect(result).toEqual([
      { id: "claude-native", type: "agent", title: "Claude (Native)" },
      { id: "claude", type: "agent", title: "Claude (Classic)" },
      { id: "claude-gateway", type: "agent", title: "Claude (Gateway • Experimental)" },
    ]);
  });

  it("설치 미완료 및 로그인 미완료 CLI에 비활성화 사유를 표시한다", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude", label: "Claude", available: false, signedIn: true },
      ],
      "agent",
    );

    expect(result).toEqual([
      { id: "claude", type: "agent", title: "Claude (Classic)", disabled: true, disabledReason: "Not installed" },
    ]);
  });
});
