import { describe, expect, it } from "vitest";

import { combineAgentCliLaunchMetadata } from "../../fleet-plugins/terminal/server/agent-api/agent-cli-launch-metadata.js";

const METADATA = [
  { id: "claude-native", label: "Claude (Native)" },
  { id: "claude-gateway", label: "Claude (Gateway)" },
] as const;

describe("combineAgentCliLaunchMetadata", () => {
  it("설치된 바이너리와 signedIn 기본값을 각 CLI에 결합한다", () => {
    const result = combineAgentCliLaunchMetadata(
      METADATA,
      [
        { id: "claude", available: true },
        { id: "cursor-agent", available: true },
      ],
    );

    expect(result).toEqual([
      { id: "claude-native", label: "Claude (Native)", available: true, signedIn: true },
      { id: "claude-gateway", label: "Claude (Gateway)", available: true, signedIn: true },
    ]);
  });

  it("claude 바이너리가 미설치면 모든 launch kind가 available=false가 된다", () => {
    const result = combineAgentCliLaunchMetadata(
      METADATA,
      [
        { id: "claude", available: false },
        { id: "cursor-agent", available: true },
      ],
    );

    expect(result.every((cli) => cli.available === false)).toBe(true);
  });

  it("탐지 입력이 비면 available=false, signedIn=true로 둔다", () => {
    const result = combineAgentCliLaunchMetadata(METADATA, []);
    expect(result.every((cli) => cli.available === false)).toBe(true);
    expect(result.every((cli) => cli.signedIn === true)).toBe(true);
  });

  it("AI Gateway는 Claude 바이너리 설치 상태를 공유한다", () => {
    const result = combineAgentCliLaunchMetadata(METADATA, [{ id: "claude", available: true }]);
    expect(result.find((cli) => cli.id === "claude-gateway")).toMatchObject({
      available: true,
      signedIn: true,
    });
  });
});
