import { describe, expect, it } from "vitest";

import { lintPlanMarkdown, lintPlanMarkdownForWrite } from "../src/lint.js";
import { buildValidPlan } from "./fixtures.js";

describe("lintPlanMarkdown", () => {
  it("parses the required template and stable task ids", () => {
    const result = lintPlanMarkdown(buildValidPlan());

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.lanes.map((lane) => lane.id)).toEqual(["W1-A", "W1-B"]);
    expect(result.tasks.map((task) => task.id)).toEqual([
      "W1-A-T1",
      "W1-A-T2",
      "W1-A-T3",
      "W1-B-T1",
      "W1-B-T2",
      "W1-B-T3",
    ]);
  });

  it("reports missing headings and unnumbered task lists", () => {
    const markdown = buildValidPlan()
      .replace("# Acceptance Criteria\n", "")
      .replace("  - [ ] W1-A-T1 — Implement cwd sanitization", "  - [ ] Implement cwd sanitization");
    const result = lintPlanMarkdown(markdown);

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("MISSING_HEADING");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "TASK_COUNT" }));
  });

  it("rejects overlapping write sets for declared concurrent lanes", () => {
    const markdown = buildValidPlan().replace(
      "  - packages/fleet-plans/**",
      "  - packages/core-infra/src/workspace-dir/paths.ts",
    );
    const result = lintPlanMarkdown(markdown);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "WRITE_SET_OVERLAP" }));
  });

  it("rejects ambiguous fields, task numbering, and full-plan dispatch policy", () => {
    const markdown = buildValidPlan()
      .replace("- Handoff: Public WorkspaceDir export", "- Handoff:\n- Handoff: duplicate")
      .replace("W1-A-T2 — Persist cwd identity", "W1-A-T4 — Persist cwd identity")
      .replace(
        "- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only",
        "- Full-plan execution: allowed",
      );
    const result = lintPlanMarkdown(markdown);

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      "DUPLICATE_LANE_FIELD",
      "TASK_SEQUENCE",
      "FULL_PLAN_POLICY",
    ]));
  });

  it("rejects parallel Plans without declared concurrency", () => {
    const result = lintPlanMarkdown(buildValidPlan()
      .replace("- Eligible concurrent lanes: W1-B", "- Eligible concurrent lanes: none")
      .replace("- Eligible concurrent lanes: W1-A", "- Eligible concurrent lanes: none"));

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "PARALLEL_WITHOUT_CONCURRENCY" }));
  });

  it("does not let lane references outside Dispatch Manifest mask missing entries", () => {
    const markdown = buildValidPlan()
      .replace(
        "- W1-B owns packages/fleet-plans/**",
        "- W1-B owns packages/fleet-plans/**\n- Lane W1-B — decoy outside the manifest",
      )
      .replace("- Lane W1-B — exact write set, dependencies, gate, handoff, and rollback from W1-B\n", "");

    const result = lintPlanMarkdown(markdown);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "MANIFEST_MISSING_LANE",
      message: "Dispatch Manifest is missing lane W1-B",
    }));
  });

  it("requires the full-plan dispatch policy inside Dispatch Manifest", () => {
    const policy = "- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only";
    const markdown = buildValidPlan()
      .replace(`${policy}\n`, "")
      .replace("# Documentation Updates", `${policy}\n\n# Documentation Updates`);

    const result = lintPlanMarkdown(markdown);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "FULL_PLAN_POLICY" }));
  });

  it("accepts the exact legacy Ohio full-plan policy as the sole alternative", () => {
    const canonical = "- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only";
    const legacy = "- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only";
    const result = lintPlanMarkdown(buildValidPlan().replace(canonical, legacy));

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects the exact legacy Ohio full-plan policy on the strict write-path helper", () => {
    const canonical = "- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only";
    const legacy = "- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only";
    const result = lintPlanMarkdownForWrite(buildValidPlan().replace(canonical, legacy), false);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "FULL_PLAN_POLICY",
      message: `Dispatch Manifest must contain exactly: ${canonical}`,
    }));
  });

  it("rejects both canonical and legacy full-plan policy lines together", () => {
    const canonical = "- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only";
    const legacy = "- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only";
    const result = lintPlanMarkdown(buildValidPlan().replace(canonical, `${canonical}\n${legacy}`));

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "FULL_PLAN_POLICY" }));
  });

  it("rejects malformed full-plan policy variants", () => {
    const canonical = "- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only";
    for (const malformed of [
      "- Full-plan execution: unavailable",
      "- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only!",
      "- Full-plan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only",
    ]) {
      const result = lintPlanMarkdown(buildValidPlan().replace(canonical, malformed));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "FULL_PLAN_POLICY" }));
    }
  });

  it("rejects a valid canonical policy that is accompanied by a malformed Full-plan line", () => {
    const canonical = "- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only";
    const malformed = "- Full-plan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only";
    const result = lintPlanMarkdown(buildValidPlan().replace(canonical, `${canonical}\n${malformed}`));

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "FULL_PLAN_POLICY" }));
  });

  it("rejects a valid legacy policy that is accompanied by a malformed Full-plan line", () => {
    const canonical = "- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only";
    const legacy = "- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only";
    const malformed = "- Full-plan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only";
    const result = lintPlanMarkdown(buildValidPlan().replace(canonical, `${legacy}\n${malformed}`));

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "FULL_PLAN_POLICY" }));
  });

  it.each([
    ["space-separated Full Plan", "- Full Plan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only"],
    ["lowercase full-plan", "- full-plan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only"],
    ["tab-separated Full plan", "- Full\tplan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only"],
    ["no-separator Fullplan", "- Fullplan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only"],
    ["repeated-hyphen Full---plan", "- Full---plan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only"],
  ])("rejects canonical plus normalized malformed companion (%s)", (_label, malformed) => {
    const canonical = "- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only";
    const result = lintPlanMarkdown(buildValidPlan().replace(canonical, `${canonical}\n${malformed}`));

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "FULL_PLAN_POLICY" }));
  });

  it.each([
    ["space-separated Full Plan", "- Full Plan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only"],
    ["lowercase full-plan", "- full-plan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only"],
    ["tab-separated Full plan", "- Full\tplan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only"],
    ["no-separator Fullplan", "- Fullplan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only"],
    ["repeated-hyphen Full---plan", "- Full---plan Genesis invocation: unavailable; dispatch explicit same-Lane TaskRefs only"],
  ])("rejects legacy plus normalized malformed companion (%s)", (_label, malformed) => {
    const canonical = "- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only";
    const legacy = "- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only";
    const result = lintPlanMarkdown(buildValidPlan().replace(canonical, `${legacy}\n${malformed}`));

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "FULL_PLAN_POLICY" }));
  });

  it("does not treat Full-plan wording inside a Dispatch Manifest Lane description as a policy line", () => {
    const result = lintPlanMarkdown(buildValidPlan().replace(
      "- Lane W1-A — exact write set, dependencies, gate, handoff, and rollback from W1-A",
      "- Lane W1-A — exact write set, dependencies, gate, handoff, and rollback from W1-A including Full-plan notes",
    ));

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "FULL_PLAN_POLICY" }));
  });

  it("does not accept topology fields placed outside Execution Topology", () => {
    const markdown = `${buildValidPlan()
      .replace(
        "- Execution mode: Parallel\n- Shared mutable resources: none",
        "Topology prose without the required fields.",
      )}\n# Appendix\n\n- Execution mode: Parallel\n- Shared mutable resources: none\n`;

    const result = lintPlanMarkdown(markdown);

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      "EXECUTION_MODE",
      "SHARED_RESOURCES",
    ]));
  });

  it("does not parse executable lanes placed outside Waves", () => {
    const plan = buildValidPlan();
    const laneStart = plan.indexOf("### Lane W1-A");
    const manifestStart = plan.indexOf("# Dispatch Manifest");
    const laneBlock = plan.slice(laneStart, manifestStart);
    const markdown = `${plan.slice(0, laneStart)}${plan.slice(manifestStart)}\n# Appendix\n\n${laneBlock}`;

    const result = lintPlanMarkdown(markdown);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "MISSING_LANES" }));
    expect(result.lanes).toEqual([]);
    expect(result.tasks).toEqual([]);
  });

  it("exports TaskRefs only from each lane Implementation summary", () => {
    const markdown = buildValidPlan().replace(
      `- Implementation summary:
  - [ ] W1-A-T1 — Implement cwd sanitization
  - [ ] W1-A-T2 — Persist cwd identity
  - [ ] W1-A-T3 — Add cross-platform tests
- Verification/static checks:
  - pnpm --filter @dotobokuri/core-infra test`,
      `- Implementation summary: Implement the workspace directory lane
- Verification/static checks:
  - [ ] W1-A-T1 — Implement cwd sanitization
  - [ ] W1-A-T2 — Persist cwd identity
  - [ ] W1-A-T3 — Add cross-platform tests
  - pnpm --filter @dotobokuri/core-infra test`,
    );

    const result = lintPlanMarkdown(markdown);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "TASK_COUNT" }));
    expect(result.tasks.map((task) => task.id)).not.toEqual(expect.arrayContaining([
      "W1-A-T1",
      "W1-A-T2",
      "W1-A-T3",
    ]));
  });

  it("requires exact lane tokens in File Ownership", () => {
    for (const decoy of ["W1-AA", "W1-A-T1"]) {
      const result = lintPlanMarkdown(buildValidPlan().replace(
        "- W1-A owns packages/core-infra/src/workspace-dir/**",
        `- ${decoy} owns packages/core-infra/src/workspace-dir/**`,
      ));

      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: "OWNERSHIP_MISSING_LANE",
        message: "File Ownership is missing lane W1-A",
      }));
    }
  });
});
