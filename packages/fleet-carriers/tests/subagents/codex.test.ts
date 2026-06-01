import { describe, expect, it } from "vitest";

import {
  buildCodexSubagentDefinition,
  buildCodexSubagentDefinitions,
  buildCodexSubagentRoleKey,
  SUBAGENT_CARRIER_BG_COLOR,
  SUBAGENT_CARRIER_COLOR,
  SUBAGENT_CARRIER_RGB,
  type CarrierConfig,
} from "../../src/index.js";

describe("Codex subagent conversion", () => {
  it("builds stable unprefixed role keys and TOML body data", () => {
    const definition = buildCodexSubagentDefinition(createCarrierConfig("ohio"));

    expect(definition.carrierId).toBe("ohio");
    expect(definition.roleKey).toBe("ohio");
    expect(definition.description).toContain("Ohio");
    expect(definition.instructions).toContain("<your_identity>");
    expect(definition.toml.name).toBe("ohio");
    expect(definition.toml.description).toBe(definition.description);
    expect(definition.toml.model).toBe("gpt-5.5");
    expect(definition.toml.model_reasoning_effort).toBe("low");
    expect(definition.toml).not.toHaveProperty("developer_instructions");
    expect(definition.toml).not.toHaveProperty("model_instructions_file");
    expect(definition.toml).not.toHaveProperty("effort");
    expect(definition.toml).not.toHaveProperty("config_file");
  });

  it("sanitizes role keys and strips the legacy Fleet prefix", () => {
    expect(buildCodexSubagentRoleKey("fleet_vanguard")).toBe("vanguard");
    expect(buildCodexSubagentRoleKey("worker.agent")).toBe("worker_agent");
    expect(buildCodexSubagentRoleKey("awaiter/agent")).toBe("awaiter_agent");
  });

  it("rejects sanitized role keys that collide with Codex built-ins", () => {
    expect(() => buildCodexSubagentRoleKey("default")).toThrow(/reserved/);
    expect(() => buildCodexSubagentRoleKey("Explorer")).toThrow(/reserved/);
    expect(() => buildCodexSubagentRoleKey("worker")).toThrow(/reserved/);
    expect(() => buildCodexSubagentRoleKey("fleet_awaiter")).toThrow(/reserved/);
  });

  it("keeps Codex xhigh effort and accepts per-CLI overrides", () => {
    const definitions = buildCodexSubagentDefinitions({
      carrierConfigs: [createCarrierConfig("tempest")],
      enabledCarrierIds: ["tempest"],
      perCliSettingsByCarrierId: {
        tempest: { model: "gpt-5.4", effort: "high" },
      },
    });

    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.toml.model).toBe("gpt-5.4");
    expect(definitions[0]!.toml.model_reasoning_effort).toBe("high");

    const defaultDefinition = buildCodexSubagentDefinition(createCarrierConfig("tempest"));
    expect(defaultDefinition.toml.model).toBe("gpt-5.4-mini");
    expect(defaultDefinition.toml.model_reasoning_effort).toBe("xhigh");
  });

  it("rejects enabled carrier definitions whose sanitized role keys collide", () => {
    expect(() => buildCodexSubagentDefinitions({
      carrierConfigs: [
        createCarrierConfig("fleet_vanguard"),
        createCarrierConfig("vanguard"),
      ],
      enabledCarrierIds: ["fleet_vanguard", "vanguard"],
    })).toThrow(/role key collision/);

    expect(buildCodexSubagentDefinitions({
      carrierConfigs: [
        createCarrierConfig("fleet_vanguard"),
        createCarrierConfig("vanguard"),
      ],
      enabledCarrierIds: ["fleet_vanguard"],
    })).toHaveLength(1);
  });

  it("does not fall back to legacy Claude defaults", () => {
    const definition = buildCodexSubagentDefinition({
      ...createCarrierConfig("legacy-only"),
      subagent: {
        provider: "claude",
        defaultModel: "sonnet",
        defaultEffort: "max",
      },
    });

    expect(definition.toml.model).toBeUndefined();
    expect(definition.toml.model_reasoning_effort).toBeUndefined();
  });

  it("exports Rose/Magenta native subagent presentation colors", () => {
    expect(SUBAGENT_CARRIER_RGB).toEqual([216, 100, 168]);
    expect(SUBAGENT_CARRIER_COLOR).toBe("\x1b[38;2;216;100;168m");
    expect(SUBAGENT_CARRIER_BG_COLOR).toBe("\x1b[48;2;30;14;26m");
  });
});

function createCarrierConfig(id: string): CarrierConfig {
  const codexDefaults = id === "tempest"
    ? { defaultModel: "gpt-5.4-mini", defaultEffort: "xhigh" }
    : { defaultModel: "gpt-5.5", defaultEffort: "low" };

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
    color: "",
    defaultCliType: "claude",
    displayName: id[0]!.toUpperCase() + id.slice(1),
    id,
    slot: 1,
    subagent: {
      byHost: {
        claude: { defaultModel: "sonnet", defaultEffort: "low" },
        codex: codexDefaults,
      },
    },
  };
}
