import { describe, expect, it } from "vitest";

import {
  buildClaudeSubagentDefinition,
  buildClaudeSubagentDefinitions,
  CLAUDE_SUBAGENT_COLORS,
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
    expect(definition.effort).toBe("low");
    expect(definition.color).toBe("yellow");
    expect(definition).not.toHaveProperty("tools");
  });

  it("clamps Claude max effort to xhigh", () => {
    const definition = buildClaudeSubagentDefinition({
      ...createCarrierConfig("nimitz"),
      subagent: {
        byHost: {
          claude: { defaultModel: "opus[1m]", defaultEffort: "max" },
        },
      },
    });

    expect(definition.effort).toBe("xhigh");
  });

  it("includes enabled carriers with deterministic Claude colors and without cliType filtering", () => {
    const definitions = buildClaudeSubagentDefinitions({
      carrierConfigs: [
        createCarrierConfig("ohio", "codex"),
        createCarrierConfig("sentinel", "cursor"),
      ],
      enabledCarrierIds: ["ohio", "sentinel"],
    });

    expect(definitions.map((definition) => definition.name)).toEqual(["Ohio", "Sentinel"]);
    expect(definitions.map((definition) => definition.carrierId)).toEqual(["ohio", "sentinel"]);
    expect(definitions.map((definition) => definition.color)).toEqual(["yellow", "red"]);
  });

  it("maps every default carrier to a Claude 8-color enum value", () => {
    const definitions = ["nimitz", "vanguard", "chronicle", "genesis", "kirov", "ohio", "sentinel", "tempest"]
      .map((id) => buildClaudeSubagentDefinition(createCarrierConfig(id)));

    const expectedColors = {
      nimitz: "blue",
      vanguard: "cyan",
      chronicle: "green",
      genesis: "orange",
      kirov: "purple",
      ohio: "yellow",
      sentinel: "red",
      tempest: "pink",
    };

    expect(CLAUDE_SUBAGENT_COLORS).toEqual(expectedColors);
    expect(Object.fromEntries(definitions.map((definition) => [definition.carrierId, definition.color]))).toEqual(expectedColors);
  });
});

function createCarrierConfig(id: string, cliType: CarrierConfig["defaultCliType"] = "claude"): CarrierConfig {
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
    defaultCliType: cliType,
    displayName: id[0]!.toUpperCase() + id.slice(1),
    id,
    slot: 1,
    subagent: {
      provider: "claude",
      defaultModel: "sonnet",
      defaultEffort: "low",
      byHost: {
        claude: {
          defaultModel: "sonnet",
          defaultEffort: "low",
        },
      },
    },
  };
}
