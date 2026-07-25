import { describe, expect, it } from "vitest";

import { EMBEDDED_AGENT_CLI_SKILL_ASSETS } from "../src/agent-cli/assets.generated.js";

describe("plan-operations skill asset", () => {
  function skillContent(): string {
    const asset = EMBEDDED_AGENT_CLI_SKILL_ASSETS.find(
      (entry) => entry.relativePath === "plan-operations/SKILL.md",
    );
    expect(asset).toBeDefined();
    return asset?.content ?? "";
  }

  it("loads once before the first host plan_write call and reuses session context", () => {
    const content = skillContent();
    const description = content.match(/^description:\s*(.+)$/m)?.[1] ?? "";

    expect(content).toContain("name: plan-operations");
    expect(description).toContain("Load before the first host plan_write call in a session");
    expect(description).toContain("skip reloading when already in context");
    expect(content).toContain("apply it to lint corrections, audit-driven revisions, and later Plan replacements");
    expect(content).toContain("If this skill cannot be loaded, do not call `plan_write`");
  });

  it("owns host authoring, the exact required template, and Plan-state-only verification", () => {
    const content = skillContent();
    const headings = [
      "# Objective",
      "# File Ownership",
      "# Execution Topology",
      "# Waves",
      "# Dispatch Manifest",
      "# QA Gates",
      "# Acceptance Criteria",
      "# Documentation Updates",
      "# Final Review Loop",
    ];
    let previous = -1;
    for (const heading of headings) {
      const index = content.indexOf(`\n${heading}\n`);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }

    expect(content).toContain("- Execution mode: Sequential | Parallel");
    expect(content).toContain("- Shared mutable resources:");
    expect(content).toContain("### Lane W1-A — <name>");
    expect(content).toContain("- [ ] W1-A-T1 — <step>");
    expect(content).toContain("- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only");
    expect(content).toContain("`plan_write` and `plan_verify` are host-only");
    expect(content).toContain("`plan_mark_tasks` is Ohio-only");
    expect(content).toContain("It does not verify source, documentation, configuration, generated assets, tests, security, acceptance criteria, or user-visible behavior.");
  });

  it("keeps Nimitz Plan assurance optional and read-only, then hands host-authored TaskRefs to Ohio", () => {
    const content = skillContent();

    expect(content).toContain("Nimitz Plan assurance is never required for Plan authoring or Ohio dispatch.");
    expect(content).toContain("1. `<context>` required");
    expect(content).toContain("2. `<problem>` required");
    expect(content).toContain("3. `<plan_ref>` optional — sole audit trigger");
    expect(content).toContain("4. `<audit_focus>` optional — applies only when `plan_ref` is supplied");
    expect(content).toContain("`plan_ref` is the sole audit trigger");
    expect(content).toContain("`PASS | REVISE | BLOCKED`");
    expect(content).toContain("A clean audit explicitly reports no findings.");
    expect(content).toContain("never calls `plan_write`");
    expect(content).toContain("The host dispatches one same-Lane TaskRef group per Ohio request.");
    expect(content).toContain("Plan wording, topology, ownership, or task changes return to the host.");
  });
});
