import { describe, expect, it } from "vitest";

import { combineAgentCliLaunchMetadata } from "../../fleet-plugins/terminal/server/agent-api/agent-cli-launch-metadata.js";

const METADATA = [
  { id: "claude", label: "Claude" },
  { id: "claude-kimi", label: "Claude Kimi" },
  { id: "claude-glm", label: "Claude GLM" },
  { id: "codex", label: "Codex" },
] as const;

describe("combineAgentCliLaunchMetadata", () => {
  it("설치된 바이너리와 로그인 게이트를 각 CLI에 결합한다", () => {
    const result = combineAgentCliLaunchMetadata(
      METADATA,
      [
        { id: "claude", available: true },
        { id: "codex", available: true },
      ],
      [
        { cli: "claude-kimi", signedIn: true },
        { cli: "claude-glm", signedIn: false },
      ],
    );

    expect(result).toEqual([
      // 자체 인증 CLI는 게이트하지 않으므로 signedIn=true.
      { id: "claude", label: "Claude", available: true, signedIn: true },
      // model-auth 대상은 실제 로그인 상태를 반영한다.
      { id: "claude-kimi", label: "Claude Kimi", available: true, signedIn: true },
      { id: "claude-glm", label: "Claude GLM", available: true, signedIn: false },
      { id: "codex", label: "Codex", available: true, signedIn: true },
    ]);
  });

  it("claude 바이너리가 미설치면 claude 계열 3종이 모두 available=false가 된다", () => {
    const result = combineAgentCliLaunchMetadata(
      METADATA,
      [
        { id: "claude", available: false },
        { id: "codex", available: true },
      ],
      [
        { cli: "claude-kimi", signedIn: true },
        { cli: "claude-glm", signedIn: true },
      ],
    );

    expect(result.find((cli) => cli.id === "claude")?.available).toBe(false);
    expect(result.find((cli) => cli.id === "claude-kimi")?.available).toBe(false);
    expect(result.find((cli) => cli.id === "claude-glm")?.available).toBe(false);
    expect(result.find((cli) => cli.id === "codex")?.available).toBe(true);
  });

  it("탐지/auth 입력이 비면 available=false, 게이트 정보가 없으므로 signedIn=true로 둔다", () => {
    // authStatuses에 들어온 cli만 게이트 대상으로 본다(서버는 buildModelAuthState로 항상 대상 전체를 넘긴다).
    // 따라서 입력이 비면 어떤 CLI도 게이트하지 않는다.
    const result = combineAgentCliLaunchMetadata(METADATA, [], []);
    expect(result.every((cli) => cli.available === false)).toBe(true);
    expect(result.every((cli) => cli.signedIn === true)).toBe(true);
  });

  it("게이트 대상이 명시적으로 미로그인이면 signedIn=false가 된다", () => {
    const result = combineAgentCliLaunchMetadata(
      METADATA,
      [{ id: "claude", available: true }],
      [
        { cli: "claude-kimi", signedIn: false },
        { cli: "claude-glm", signedIn: false },
      ],
    );
    expect(result.find((cli) => cli.id === "claude-kimi")?.signedIn).toBe(false);
    expect(result.find((cli) => cli.id === "claude-glm")?.signedIn).toBe(false);
    // 게이트 대상이 아닌 claude는 영향받지 않는다.
    expect(result.find((cli) => cli.id === "claude")?.signedIn).toBe(true);
  });
});
