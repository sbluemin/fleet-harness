import { describe, expect, it } from "vitest";

import { lintPlanMarkdown } from "../src/lint.js";
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
        "- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only",
        "- Full-plan Ohio invocation: allowed",
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
    const policy = "- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only";
    const markdown = buildValidPlan()
      .replace(`${policy}\n`, "")
      .replace("# Documentation Updates", `${policy}\n\n# Documentation Updates`);

    const result = lintPlanMarkdown(markdown);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "FULL_PLAN_POLICY" }));
  });
});
