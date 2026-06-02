import { describe, expect, it } from "vitest";

import { StatusOverlayController } from "../../src/dispatch/status-overlay.js";
import type { CarrierConfig, CarrierCliType, ModelSelection } from "../../src/dispatch/types.js";

describe("StatusOverlayController", () => {
  it("uses the target CLI's persona default before provider defaults", async () => {
    let savedSelection: ModelSelection | null = null;
    const controller = new StatusOverlayController({
      applyAgentCliTypeSelectionUpdate: async (_carrierId, _newCliType, _defaultCliType, _previousCliType, _previousSelection, selection) => {
        savedSelection = selection;
      },
      getAgentCliSelection: () => undefined,
      getAvailableModels: (cliType) => ({
        defaultModel: cliType === "codex" ? "gpt-provider-default" : "sonnet",
        effort: { supported: true, levels: ["low", "medium", "high"], default: "medium" },
        models: cliType === "codex"
          ? [
            { modelId: "gpt-provider-default", name: "Provider Default" },
            { modelId: "gpt-5.4-mini", name: "GPT 5.4 Mini" },
          ]
          : [{ modelId: "sonnet", name: "Sonnet" }],
        name: cliType,
      }),
      getCarrierConfig: () => createCarrierConfig(),
      getCurrentModelSelection: () => ({ model: "sonnet", effort: "low" }),
      getEffort: () => ({ supported: true, levels: ["low", "medium", "high"], default: "medium" }),
      getEntries: () => [],
      getRegisteredOrder: () => ["vanguard"],
      getResolvedCliType: () => "claude",
      notifyStatusUpdate: () => undefined,
      refreshAgentPanel: () => undefined,
      saveAgentCliSelection: () => undefined,
      syncModelConfig: () => undefined,
      updateCarrierCliType: () => undefined,
    });

    const result = await controller.changeCliType("vanguard", "codex");

    expect(result).toEqual({
      model: "gpt-5.4-mini",
      effort: "low",
      isDefault: true,
    });
    expect(savedSelection).toEqual({ model: "gpt-5.4-mini", effort: "low" });
  });
});

function createCarrierConfig(): CarrierConfig {
  return {
    defaultCliType: "claude" as CarrierCliType,
    defaultEffort: "low",
    defaultModel: "sonnet",
    displayName: "Vanguard",
    id: "vanguard",
    slot: 6,
    subagent: {
      byHost: {
        codex: { defaultModel: "gpt-5.4-mini", defaultEffort: "low" },
      },
    },
  };
}
