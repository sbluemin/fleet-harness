import { describe, expect, it } from "vitest";

import { buildAgentCliLaunchKinds } from "../server/agent-api/agent-cli-launch-kinds.js";

describe("buildAgentCliLaunchKinds", () => {
  it("모든 CLI를 Operation Controls 목록에 포함한다", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude-native", label: "Claude (Native)", available: true, signedIn: true },
        { id: "claude", label: "Claude", available: true, signedIn: true },
        { id: "codex", label: "Codex", available: true, signedIn: true },
        { id: "claude-gateway", label: "Claude (Gateway)", available: true, signedIn: true },
      ],
      "agent",
    );

    // (Classic)은 같은 CLI에 다른 변형이 있는 Claude에만 붙는다 — Codex는 대비할 변형이 없다.
    expect(result).toEqual([
      { id: "claude-native", type: "agent", title: "Claude (Native)" },
      { id: "claude", type: "agent", title: "Claude (Classic)" },
      { id: "codex", type: "agent", title: "Codex" },
      { id: "claude-gateway", type: "agent", title: "Claude (Gateway)" },
    ]);
  });

  it("설치 미완료 및 로그인 미완료 CLI에 비활성화 사유를 표시한다", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude", label: "Claude", available: false, signedIn: true },
        { id: "codex", label: "Codex", available: true, signedIn: false },
      ],
      "agent",
    );

    expect(result).toEqual([
      { id: "claude", type: "agent", title: "Claude (Classic)", disabled: true, disabledReason: "Not installed" },
      { id: "codex", type: "agent", title: "Codex", disabled: true, disabledReason: "Sign in required" },
    ]);
  });
});
