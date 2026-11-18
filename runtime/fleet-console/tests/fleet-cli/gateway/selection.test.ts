import { buildAiGatewayCatalog } from "@fleet-console/ai-gateway";
import { describe, expect, it } from "vitest";

import {
  buildGatewayModelChoices,
  effortLadderFor,
  toStoredModels,
  withModelEfforts,
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

  it("replaces one model's efforts without dropping the others", () => {
    const id = firstModelWithLadder();
    const models = [{ id, efforts: ["high"] }, { id: "other" }];
    expect(withModelEfforts(models, id, ["low", "high"])).toEqual([
      { id, efforts: ["low", "high"] },
      { id: "other" },
    ]);
    expect(effortLadderFor(id).length).toBeGreaterThan(0);
    expect(toStoredModels([id], models)).toEqual([{ id, efforts: ["high"] }]);
    expect(toStoredModels(["codex--gpt-6.1-sol"], undefined)).toEqual([
      { id: "codex--gpt-6.1-sol", efforts: ["low", "medium", "high"] },
    ]);
    const highOff = [{ id, efforts: ["low", "medium"] }];
    expect(toStoredModels([id], highOff)).toEqual(highOff);
  });
});
