import { describe, expect, it } from "vitest";
import type { OperationNode } from "@fleet-console/sdk/operations";

import { buildAgentLaunchKindBackfillPatch } from "../server/agent.js";

describe("buildAgentLaunchKindBackfillPatch", () => {
  it("cliId만 있는 terminal agent Operation은 launchKindId를 백필한다", () => {
    const operation = makeOperation({ payload: { cliId: "claude", cwd: "/tmp/work" } });

    expect(buildAgentLaunchKindBackfillPatch(operation)).toEqual({
      payload: { cliId: "claude", cwd: "/tmp/work", launchKindId: "claude" },
    });
  });

  it("launchKindId가 이미 있으면 no-op이다", () => {
    const operation = makeOperation({ payload: { cliId: "claude", launchKindId: "codex" } });

    expect(buildAgentLaunchKindBackfillPatch(operation)).toBeNull();
  });

  it("cliId가 없으면 no-op이다", () => {
    const operation = makeOperation({ payload: { cwd: "/tmp/work" } });

    expect(buildAgentLaunchKindBackfillPatch(operation)).toBeNull();
  });

  it("terminal shell Operation은 no-op이다", () => {
    const operation = makeOperation({ type: "shell", payload: { cliId: "claude" } });

    expect(buildAgentLaunchKindBackfillPatch(operation)).toBeNull();
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
