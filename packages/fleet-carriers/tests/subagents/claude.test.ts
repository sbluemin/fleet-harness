import { describe, expect, it } from "vitest";

import {
  buildClaudeSubagentDefinition,
  buildClaudeSubagentDefinitions,
  type CarrierConfig,
} from "../../src/index.js";

describe("Claude subagent conversion", () => {
  it("builds stable schema-safe names and carrier prompt contracts", () => {
    const definition = buildClaudeSubagentDefinition(createCarrierConfig("ohio"));

    expect(definition.carrierId).toBe("ohio");
    expect(definition.name).toBe("Ohio");
    expect(definition.description).toContain("Ohio");
    expect(definition.description).toContain("Multi-wave execution");
    expect(definition.prompt).toContain("<your_identity>");
    expect(definition.prompt).toContain("<your_permissions>");
    expect(definition.prompt).toContain("<output_format>");
    expect(definition.model).toBe("sonnet");
    expect(definition).not.toHaveProperty("tools");
  });

  it("includes enabled carriers without cliType filtering", () => {
    const definitions = buildClaudeSubagentDefinitions({
      carrierConfigs: [
        createCarrierConfig("ohio", "codex"),
        createCarrierConfig("sentinel", "cursor"),
      ],
      enabledCarrierIds: ["ohio", "sentinel"],
    });

    expect(definitions.map((definition) => definition.name)).toEqual(["Ohio", "Sentinel"]);
    expect(definitions.map((definition) => definition.carrierId)).toEqual(["ohio", "sentinel"]);
  });
});

function createCarrierConfig(id: string, cliType: CarrierConfig["cliType"] = "claude"): CarrierConfig {
  return {
    carrierMetadata: {
      category: "operations",
      outputFormat: "Report completion.",
      permissions: ["Execute only the assigned wave."],
      principles: ["Follow the plan."],
      requestBlocks: [],
      summary: "Multi-wave execution",
      title: "Captain",
      whenNotToUse: [],
      whenToUse: ["plan-file execution"],
    },
    cliType,
    color: "",
    defaultCliType: cliType,
    defaultModel: "sonnet",
    displayName: id[0]!.toUpperCase() + id.slice(1),
    id,
    slot: 1,
  };
}
