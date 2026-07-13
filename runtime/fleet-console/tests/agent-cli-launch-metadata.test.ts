import { describe, expect, it } from "vitest";

import { combineAgentCliLaunchMetadata } from "../../fleet-plugins/terminal/server/agent-api/agent-cli-launch-metadata.js";

const METADATA = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
] as const;

describe("combineAgentCliLaunchMetadata", () => {
  it("설치된 바이너리와 signedIn 기본값을 각 CLI에 결합한다", () => {
    const result = combineAgentCliLaunchMetadata(
      METADATA,
      [
        { id: "claude", available: true },
        { id: "codex", available: true },
        { id: "cursor-agent", available: true },
      ],
      [],
    );

    expect(result).toEqual([
      { id: "claude", label: "Claude", available: true, signedIn: true },
      { id: "codex", label: "Codex", available: true, signedIn: true },
    ]);
  });

  it("claude 바이너리가 미설치면 claude가 available=false가 된다", () => {
    const result = combineAgentCliLaunchMetadata(
      METADATA,
      [
        { id: "claude", available: false },
        { id: "codex", available: true },
        { id: "cursor-agent", available: true },
      ],
      [],
    );

    expect(result.find((cli) => cli.id === "claude")?.available).toBe(false);
    expect(result.find((cli) => cli.id === "codex")?.available).toBe(true);
  });

  it("탐지/auth 입력이 비면 available=false, signedIn=true로 둔다", () => {
    const result = combineAgentCliLaunchMetadata(METADATA, [], []);
    expect(result.every((cli) => cli.available === false)).toBe(true);
    expect(result.every((cli) => cli.signedIn === true)).toBe(true);
  });

  it("authStatuses에 명시적 미로그인이 있으면 해당 CLI의 signedIn=false가 된다", () => {
    const result = combineAgentCliLaunchMetadata(
      METADATA,
      [{ id: "claude", available: true }],
      [{ cli: "claude", signedIn: false }],
    );
    expect(result.find((cli) => cli.id === "claude")?.signedIn).toBe(false);
    // authStatuses에 없는 CLI는 signedIn=true로 둔다.
    expect(result.find((cli) => cli.id === "codex")?.signedIn).toBe(true);
  });
});
