import { buildAiGatewayCatalog } from "@dotobokuri/core-ai-gateway";
import { describe, expect, it } from "vitest";

import {
  buildGatewayModelChoices,
  effortLadderFor,
  toStoredModels,
  withModelEfforts,
  withModelHostOnly,
} from "../../../cli/gateway/selection.js";

function firstModelWithLadder(): string {
  for (const provider of buildAiGatewayCatalog().providers) {
    const model = provider.models.find((entry) => (entry.effort?.levels.length ?? 0) > 0);
    if (model) return model.id;
  }
  throw new Error("catalog has no model with an effort ladder");
}

describe("gateway model choices", () => {

  it("drops a stored id the catalog no longer knows", () => {
    const choices = buildGatewayModelChoices({ version: 1, models: [{ id: "retired-model" }] });
    expect(choices.selectedIds).toEqual([]);
  });
});

describe("stored model selection", () => {

  it("flips host-only without disturbing the effort narrowing", () => {
    const models = [{ id: "a", efforts: ["high"] }];
    expect(withModelHostOnly(models, "a", true)).toEqual([{ id: "a", efforts: ["high"], hostOnly: true }]);
    expect(withModelHostOnly([{ id: "a", efforts: ["high"], hostOnly: true }], "a", false)).toEqual([
      { id: "a", efforts: ["high"] },
    ]);
  });
});
