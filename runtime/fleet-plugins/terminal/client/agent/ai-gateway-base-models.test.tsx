// @vitest-environment jsdom

import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../shared/index.js", () => ({
  TerminalSurface: () => createElement("div", { className: "terminal-surface-stub" }),
}));

import { selectAiGatewayBaseModels } from "./index.js";
import type { AiGatewayCatalogModel } from "./settings.js";

function model(id: string, overrides: Partial<AiGatewayCatalogModel> = {}): AiGatewayCatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200000,
    oneMillion: false,
    maxMode: false,
    fast: id.endsWith("-fast"),
    capabilityClass: null,
    description: null,
    effort: null,
    ...overrides,
  } as AiGatewayCatalogModel;
}

describe("AI Gateway base model picker", () => {
  it("hides a fast model whose base is present", () => {
    const models = [model("cursor--grok-4.6"), model("cursor--grok-4.6-fast")];
    expect(selectAiGatewayBaseModels(models).map((entry) => entry.id))
      .toEqual(["cursor--grok-4.6"]);
  });

  it("keeps a fast-suffixed model that names no base in the catalog", () => {
    // The suffix is part of this model's own name; xAI lists no `grok-composer-2.5`.
    const models = [model("xai--grok-4.6"), model("xai--grok-composer-2.5-fast")];
    expect(selectAiGatewayBaseModels(models).map((entry) => entry.id))
      .toEqual(["xai--grok-4.6", "xai--grok-composer-2.5-fast"]);
  });

  it("resolves each fast model against its own base, not the provider as a whole", () => {
    const models = [
      model("cursor--composer-2.5"),
      model("cursor--composer-2.5-fast"),
      model("cursor--grok-4.5"),
      model("cursor--grok-4.5-fast"),
      model("xai--grok-composer-2.5-fast"),
    ];
    expect(selectAiGatewayBaseModels(models).map((entry) => entry.id)).toEqual([
      "cursor--composer-2.5",
      "cursor--grok-4.5",
      "xai--grok-composer-2.5-fast",
    ]);
  });

  it("leaves a catalog without fast models untouched", () => {
    const models = [model("cursor--auto"), model("cursor--claude-opus-5")];
    expect(selectAiGatewayBaseModels(models)).toHaveLength(2);
  });
});
