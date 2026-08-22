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
  it("groups the catalog by provider and preselects what is already exposed", () => {
    const catalog = buildAiGatewayCatalog();
    const anyModel = catalog.providers.flatMap((provider) => provider.models).at(0);
    if (!anyModel) throw new Error("catalog is empty");
    const choices = buildGatewayModelChoices({ version: 1, models: [{ id: anyModel.id }] });

    expect(Object.keys(choices.groups).length).toBeGreaterThan(0);
    expect(choices.selectedIds).toEqual([anyModel.id]);
  });

  it("drops a stored id the catalog no longer knows", () => {
    const choices = buildGatewayModelChoices({ version: 1, models: [{ id: "retired-model" }] });
    expect(choices.selectedIds).toEqual([]);
  });
});

describe("stored model selection", () => {
  it("carries the effort narrowing and host-only mark of models that stay", () => {
    const previous = [
      { id: "a", efforts: ["high"] },
      { id: "b", hostOnly: true },
    ];
    // 'c'를 새로 켜는 일이 a·b의 세부 설정을 지우면 안 된다.
    expect(toStoredModels(["a", "b", "c"], previous)).toEqual([
      { id: "a", efforts: ["high"] },
      { id: "b", hostOnly: true },
      { id: "c" },
    ]);
  });

  it("forgets a model that was turned off", () => {
    expect(toStoredModels(["a"], [{ id: "a" }, { id: "b", efforts: ["low"] }])).toEqual([{ id: "a" }]);
  });

  it("ignores a repeated id", () => {
    expect(toStoredModels(["a", "a"], [])).toEqual([{ id: "a" }]);
  });

  it("removes the efforts key when the whole ladder is chosen", () => {
    const models = [{ id: "a", efforts: ["low"], hostOnly: true as const }];
    expect(withModelEfforts(models, "a", [])).toEqual([{ id: "a", hostOnly: true }]);
    expect(withModelEfforts(models, "a", ["low", "high"])).toEqual([
      { id: "a", hostOnly: true, efforts: ["low", "high"] },
    ]);
  });

  it("flips host-only without disturbing the effort narrowing", () => {
    const models = [{ id: "a", efforts: ["high"] }];
    expect(withModelHostOnly(models, "a", true)).toEqual([{ id: "a", efforts: ["high"], hostOnly: true }]);
    expect(withModelHostOnly([{ id: "a", efforts: ["high"], hostOnly: true }], "a", false)).toEqual([
      { id: "a", efforts: ["high"] },
    ]);
  });

  it("leaves other models untouched", () => {
    const models = [{ id: "a" }, { id: "b", efforts: ["low"] }];
    expect(withModelEfforts(models, "a", ["high"])[1]).toEqual({ id: "b", efforts: ["low"] });
  });
});

describe("effort ladder lookup", () => {
  it("returns the catalog ladder for a known model", () => {
    expect(effortLadderFor(firstModelWithLadder()).length).toBeGreaterThan(0);
  });

  it("returns nothing for a model outside the catalog", () => {
    expect(effortLadderFor("retired-model")).toEqual([]);
  });
});
