import { resolveAiGatewaySelection } from "@dotobokuri/core-ai-gateway";
import { describe, expect, it } from "vitest";

import { isGatewayLaunchEffortAllowed } from "../server/agent-api/launch.js";
import { nativeClaudeAnalystModels } from "../server/agent-api/analysis-types.js";

function selectionFor(models: readonly { id: string; efforts?: readonly string[] }[]) {
  return resolveAiGatewaySelection({
    version: 1,
    models: models.map((model) => ({ id: model.id, ...(model.efforts ? { efforts: [...model.efforts] } : {}) })),
  });
}

function modelIn(selection: ReturnType<typeof resolveAiGatewaySelection>, id: string) {
  const model = selection.models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`Expected ${id} to be enabled`);
  return model;
}

describe("isGatewayLaunchEffortAllowed", () => {
  it("accepts the rungs the model actually exposes", () => {
    const selection = selectionFor([{ id: "codex--gpt-5.6-sol-fast" }]);
    const model = modelIn(selection, "codex--gpt-5.6-sol-fast");

    expect(isGatewayLaunchEffortAllowed(selection, model, "high")).toBe(true);
    expect(isGatewayLaunchEffortAllowed(selection, model, "xhigh")).toBe(true);
    // 게이트웨이 사다리의 `ultra`는 Claude Code가 받지 않는 값이다.
    expect(isGatewayLaunchEffortAllowed(selection, model, "ultra")).toBe(false);
    expect(isGatewayLaunchEffortAllowed(selection, model, "nonsense")).toBe(false);
  });

  /**
   * ultracode는 이 모델의 단이 아니라 Claude Code 세션 모드이고, 상류에는 언제나 xhigh로 나간다.
   * 그래서 xhigh를 내놓는 모델에만 걸어 줄 수 있다 — 걸지 못하는 모델에 허용하면 사용자가 고른
   * 단이 상류에서 조용히 깎인다.
   */
  it("allows ultracode exactly where the model can honour xhigh", () => {
    const wide = selectionFor([{ id: "codex--gpt-5.6-sol-fast" }]);
    expect(isGatewayLaunchEffortAllowed(wide, modelIn(wide, "codex--gpt-5.6-sol-fast"), "ultracode")).toBe(true);

    const narrow = selectionFor([{ id: "kimi--k3", efforts: ["max"] }]);
    expect(isGatewayLaunchEffortAllowed(narrow, modelIn(narrow, "kimi--k3"), "max")).toBe(true);
    expect(isGatewayLaunchEffortAllowed(narrow, modelIn(narrow, "kimi--k3"), "ultracode")).toBe(false);
  });
});

describe("Analyst model options", () => {
  /**
   * Analyst는 강도를 깊이로만 읽고 워크플로우 오케스트레이션을 켤 수 없다. 실행 강도 목록과 추론
   * 사다리를 다시 하나로 합치면, 이 표면이 아무 변경 없이 ultracode를 내놓게 된다.
   */
  it("offers the depth ladder only, never the session mode", () => {
    for (const option of nativeClaudeAnalystModels()) {
      expect(option.effort.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });
});
