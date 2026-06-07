import { describe, expect, it } from "vitest";

import { createCarrierRuntime } from "@dotobokuri/fleet-carriers";

import { createSystemPromptBuilder, buildSubagentsSection } from "./index.js";

describe("Admiral prompts", () => {
  it("keeps subagents out of the static system prompt while preserving roster", () => {
    const prompt = createSystemPromptBuilder({
      carrierRuntime: createCarrierRuntime(),
      mcpRegistry: [],
    }).build(false);

    expect(prompt).toContain('<fleet section="roster">');
    expect(prompt).not.toContain('<fleet section="subagents">');
  });

  it("returns no subagents section for an empty enabled set", () => {
    expect(buildSubagentsSection([])).toBeUndefined();
  });

  it("formats native subagent names and dispatch guidance", () => {
    const section = buildSubagentsSection([
      { carrierId: "ohio", displayName: "Ohio", nativeName: "Ohio" },
      { carrierId: "sentinel", nativeName: "Sentinel" },
    ]);

    expect(section).toContain('<fleet section="subagents">');
    expect(section).toContain("Ohio (ohio)");
    expect(section).toContain("`Ohio`");
    expect(section).toContain("sentinel");
    expect(section).toContain("`Sentinel`");
    expect(section).toContain("do not emit `[carrier:result]`");
    expect(section).toContain("`carrier_dispatch` remains available");
  });
});
