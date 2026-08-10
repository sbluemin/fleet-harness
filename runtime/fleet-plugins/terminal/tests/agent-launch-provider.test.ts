import { describe, expect, it } from "vitest";
import type { OperationNode } from "@fleet-console/sdk/operations";

import { buildAgentLaunchProviderBackfillPatch } from "../server/agent.js";
import { agentLaunchProviderFromModel, isAgentLaunchProvider } from "../server/agent-api/launch-provider.js";

describe("agentLaunchProviderFromModel", () => {
  it("게이트웨이 모델 id의 접두 공급자를 읽는다", () => {
    expect(agentLaunchProviderFromModel("cursor--grok-4.5")).toBe("cursor");
    expect(agentLaunchProviderFromModel("codex--gpt-5.6")).toBe("codex");
    expect(agentLaunchProviderFromModel("kimi--k2")).toBe("kimi");
    expect(agentLaunchProviderFromModel("opencode--grok-code")).toBe("opencode");
  });

  it("순정 Claude 별칭과 모델 미지정 실행은 claude다", () => {
    expect(agentLaunchProviderFromModel("fable[1m]")).toBe("claude");
    expect(agentLaunchProviderFromModel("sonnet")).toBe("claude");
    expect(agentLaunchProviderFromModel(undefined)).toBe("claude");
  });

  // 카탈로그가 새 공급자를 들이거나 모델 id 문법이 바뀌어도 마크는 조용히 비지 않아야 한다 —
  // 모르는 접두는 실패가 아니라 순정 Claude로 읽는다.
  it("알 수 없는 접두는 claude로 되돌린다", () => {
    expect(agentLaunchProviderFromModel("unknown--model")).toBe("claude");
    expect(agentLaunchProviderFromModel("--leading")).toBe("claude");
  });
});

describe("isAgentLaunchProvider", () => {
  it("공급자 어휘만 통과시킨다", () => {
    expect(isAgentLaunchProvider("claude")).toBe(true);
    expect(isAgentLaunchProvider("cursor")).toBe(true);
    expect(isAgentLaunchProvider("gemini")).toBe(false);
    expect(isAgentLaunchProvider(undefined)).toBe(false);
    expect(isAgentLaunchProvider(7)).toBe(false);
  });
});

describe("buildAgentLaunchProviderBackfillPatch", () => {
  it("공급자 기록이 없는 agent Operation을 claude로 메운다", () => {
    const operation = makeOperation({ payload: { cliId: "claude-gateway", cwd: "/tmp/work" } });

    expect(buildAgentLaunchProviderBackfillPatch(operation)).toEqual({
      payload: { cliId: "claude-gateway", cwd: "/tmp/work", launchProvider: "claude" },
    });
  });

  it("이미 기록된 공급자는 덮지 않는다", () => {
    const operation = makeOperation({ payload: { launchProvider: "cursor" } });

    expect(buildAgentLaunchProviderBackfillPatch(operation)).toBeNull();
  });

  it("어휘 밖의 값은 기록으로 인정하지 않고 claude로 되돌린다", () => {
    const operation = makeOperation({ payload: { launchProvider: "gemini" } });

    expect(buildAgentLaunchProviderBackfillPatch(operation)).toEqual({
      payload: { launchProvider: "claude" },
    });
  });

  it("terminal agent가 아닌 Operation은 no-op이다", () => {
    expect(buildAgentLaunchProviderBackfillPatch(makeOperation({ type: "shell" }))).toBeNull();
    expect(buildAgentLaunchProviderBackfillPatch(makeOperation({ pluginId: "diff" }))).toBeNull();
  });
});

function makeOperation(input: Partial<OperationNode> = {}): OperationNode {
  return {
    id: "operation-1",
    theaterId: "theater-1",
    type: "agent",
    pluginId: "terminal",
    title: "Claude",
    payload: {},
    geometry: null,
    ts: { createdAt: 1_000, updatedAt: 1_000 },
    ...input,
  };
}
