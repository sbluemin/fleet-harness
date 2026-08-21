import { describe, expect, it } from "vitest";

import { EMBEDDED_AGENT_CLI_SKILL_ASSETS } from "../src/agent-cli/assets.generated.js";

const EXPECTED_SKILLS = [
  "orchestration/SKILL.md",
  "professional-pushback/SKILL.md",
] as const;

function skillBody(relativePath: string): string {
  const asset = EMBEDDED_AGENT_CLI_SKILL_ASSETS.find((entry) => entry.relativePath === relativePath);
  expect(asset, `${relativePath} must be embedded`).toBeDefined();
  return asset!.content;
}

describe("embedded Fleet skills", () => {
  it("embeds exactly the two selected on-demand skills", () => {
    expect(EMBEDDED_AGENT_CLI_SKILL_ASSETS.map((entry) => entry.relativePath)).toEqual(EXPECTED_SKILLS);
  });

  it.each(EXPECTED_SKILLS)("keeps %s frontmatter aligned with its directory", (relativePath) => {
    const name = relativePath.split("/")[0]!;
    const content = skillBody(relativePath);
    expect(content).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
  });

  it("keeps Professional Pushback material, evidenced, and user-settled", () => {
    const content = skillBody("professional-pushback/SKILL.md");
    expect(content).toContain("State the objection plainly before executing");
    expect(content).toContain("concrete evidence or a checkable technical reason");
    expect(content).toContain("Match its force to the impact");
    expect(content).toContain("one actionable, clearly better alternative");
    expect(content).toContain("could materially change whether the objection holds");
    expect(content).toContain("treat it as settled even if they did not rebut the technical case");
    expect(content).toContain("do not add an unasked compromise");
    expect(content).toContain("previously unknown major failure mode");
    expect(content).toContain("equivalent trade-off");
    expect(content).not.toContain("Context Confidence");
    expect(content).not.toContain("assumption-audit");
  });

  it("keeps orchestration focused on semantic execution-graph policy", () => {
    const content = skillBody("orchestration/SKILL.md");
    expect(content).toContain("derive the smallest useful graph");
    expect(content).toContain("Dispatch only branches whose outputs can change the host's decision");
    expect(content).toContain("Keep decision and integration nodes on the host");
    expect(content).toContain("observable acceptance criterion");
    expect(content).toContain("Cancel branches whose information value has disappeared");
    expect(content).toContain("stop dispatching when the host has sufficient evidence to act");
    expect(content).toContain("propose branch may intentionally explore an open decision");
    expect(content).toContain("only reduces coverage");
    expect(content).toContain("Retry once only when the failure is plausibly transient");
    expect(content).not.toContain("gateway_models");
    expect(content).not.toContain("agentTypes");
    expect(content).not.toContain("subagent_type");
    expect(content).not.toContain("modelId");
    expect(content).not.toContain("opts.model");
    expect(content).not.toContain("Pipeline by default");
    expect(content).not.toContain("Use a barrier only when");
    expect(content).not.toContain("workflow-implementing");
    expect(content).not.toContain("providerPriority");
  });

  it("keeps implementation and judgment on the host by default", () => {
    const content = skillBody("orchestration/SKILL.md");
    expect(content).toContain("implementation normally is not");
    expect(content).toContain("Implementation delegation is an exception");
    expect(content).toContain("Implement directly on the host unless **all** of these are true");
    expect(content).toContain("inspect the actual diff");
    expect(content).toContain("Run results are inputs, not conversation turns");
  });

  it("keeps pin mechanics out of Professional Pushback", () => {
    const content = skillBody("professional-pushback/SKILL.md");
    expect(content).not.toContain("gateway_models");
    expect(content).not.toContain("subagent_type");
    expect(content).not.toContain("opts.model");
  });

  it("keeps volatile ranking policy out of orchestration", () => {
    const content = skillBody("orchestration/SKILL.md");
    expect(content).not.toContain("providerPriority");
    expect(content).not.toContain("routingTieBandPoints");
    expect(content).not.toContain("usedPercent");
  });
});
