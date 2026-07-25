import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  markPlanTasksComplete,
  readPlanMarkdown,
  writePlanMarkdown,
} from "../src/store.js";
import { buildValidPlan } from "./fixtures.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

describe("Fleet Plan store", () => {
  it("rejects filename-shaped or ambiguous Plan identities", () => {
    const { workspaceRoot, dataDir } = makePaths();

    for (const planId of ["plan.md", "plan..v2", "plan."]) {
      expect(() => writePlanMarkdown(dataDir, workspaceRoot, planId, buildValidPlan()))
        .toThrow(/Invalid plan id/);
    }
  });

  it("writes by host-bound workspace root and reads the Plan through its cross-workspace PlanRef", () => {
    const { workspaceRoot, dataDir } = makePaths();
    const result = writePlanMarkdown(dataDir, workspaceRoot, "workspace-plan-mcp", buildValidPlan());

    expect(result.written).toBe(true);
    expect(result.planRef).toMatch(/:workspace-plan-mcp$/);
    const read = readPlanMarkdown(dataDir, result.planRef);
    expect(read.lint.valid).toBe(true);
    expect(read.lint.tasks[0]?.taskRef).toBe(`${result.planRef}#W1-A-T1`);
  });

  it("preserves an existing valid Plan when replacement lint fails", () => {
    const { workspaceRoot, dataDir } = makePaths();
    const first = writePlanMarkdown(dataDir, workspaceRoot, "safe-plan", buildValidPlan());
    const invalid = writePlanMarkdown(dataDir, workspaceRoot, "safe-plan", "# Objective\n\nIncomplete\n");

    expect(invalid.written).toBe(false);
    expect(readPlanMarkdown(dataDir, first.planRef).markdown).toBe(buildValidPlan());
  });

  it("does not create workspace storage when initial Markdown lint fails", () => {
    const { workspaceRoot, dataDir } = makePaths();

    const invalid = writePlanMarkdown(dataDir, workspaceRoot, "invalid-plan", "# Objective\n\nIncomplete\n");

    expect(invalid.written).toBe(false);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("rejects creating a new Plan with the retired exact Ohio full-plan policy without creating storage", () => {
    const { workspaceRoot, dataDir } = makePaths();
    const legacyPlan = buildLegacyPlan();

    const created = writePlanMarkdown(dataDir, workspaceRoot, "legacy-create", legacyPlan);

    expect(created.written).toBe(false);
    expect(created.lint.valid).toBe(false);
    expect(created.lint.diagnostics).toContainEqual(expect.objectContaining({ code: "FULL_PLAN_POLICY" }));
    expect(existsSync(dataDir)).toBe(false);
  });

  it("rejects a new Plan with canonical manifest policy plus an exact legacy companion outside the manifest without creating storage", () => {
    const { workspaceRoot, dataDir } = makePaths();
    const markdown = buildValidPlan().replace(
      "# Documentation Updates\n\n- Update host and Carrier Plan workflow documentation.",
      `# Documentation Updates\n\n${LEGACY_FULL_PLAN_POLICY}\n\n- Update host and Carrier Plan workflow documentation.`,
    );

    const created = writePlanMarkdown(dataDir, workspaceRoot, "companion-policy", markdown);

    expect(created.written).toBe(false);
    expect(created.lint.valid).toBe(false);
    expect(created.lint.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["FULL_PLAN_POLICY"]);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("allows replacing an existing exact-legacy Plan with legacy or canonical policy", () => {
    const { workspaceRoot, dataDir } = makePaths();
    const seeded = seedLegacyPlan(dataDir, workspaceRoot, "legacy-replace");

    const legacyReplace = writePlanMarkdown(dataDir, workspaceRoot, "legacy-replace", buildLegacyPlan());
    expect(legacyReplace.written).toBe(true);
    expect(readPlanMarkdown(dataDir, seeded.planRef).markdown).toBe(buildLegacyPlan());

    const canonicalReplace = writePlanMarkdown(dataDir, workspaceRoot, "legacy-replace", buildValidPlan());
    expect(canonicalReplace.written).toBe(true);
    expect(readPlanMarkdown(dataDir, seeded.planRef).markdown).toBe(buildValidPlan());
  });

  it("rejects replacing a canonical Plan with the retired exact Ohio full-plan policy", () => {
    const { workspaceRoot, dataDir } = makePaths();
    const first = writePlanMarkdown(dataDir, workspaceRoot, "canonical-plan", buildValidPlan());

    const replaced = writePlanMarkdown(dataDir, workspaceRoot, "canonical-plan", buildLegacyPlan());

    expect(replaced.written).toBe(false);
    expect(replaced.lint.diagnostics).toContainEqual(expect.objectContaining({ code: "FULL_PLAN_POLICY" }));
    expect(readPlanMarkdown(dataDir, first.planRef).markdown).toBe(buildValidPlan());
  });

  it("reads and completes tasks on an existing exact-legacy Plan", () => {
    const { workspaceRoot, dataDir } = makePaths();
    const seeded = seedLegacyPlan(dataDir, workspaceRoot, "legacy-compat");

    const read = readPlanMarkdown(dataDir, seeded.planRef);
    expect(read.lint.valid).toBe(true);
    expect(read.markdown).toBe(buildLegacyPlan());

    const refs = ["W1-A-T1", "W1-A-T2", "W1-A-T3"].map((id) => `${seeded.planRef}#${id}`);
    const marked = markPlanTasksComplete(dataDir, refs);
    expect(marked.completed).toEqual(refs);
    expect(readPlanMarkdown(dataDir, seeded.planRef).lint.valid).toBe(true);
  });

  it("reads externally corrupted Markdown with blocking lint diagnostics", () => {
    const { workspaceRoot, dataDir } = makePaths();
    const written = writePlanMarkdown(dataDir, workspaceRoot, "corrupt-plan", buildValidPlan());
    const workspaceName = written.planRef.slice(0, written.planRef.lastIndexOf(":"));
    const planPath = path.join(dataDir, "workspaces", workspaceName, "plans", "corrupt-plan.md");
    writeFileSync(planPath, "# Objective\n\nCorrupted\n");

    const document = readPlanMarkdown(dataDir, written.planRef);
    expect(document.markdown).toBe("# Objective\n\nCorrupted\n");
    expect(document.lint.valid).toBe(false);
    expect(document.lint.diagnostics).toContainEqual(expect.objectContaining({ code: "MISSING_HEADING" }));
  });

  it("marks only same-Lane TaskRefs and keeps the operation idempotent", () => {
    const { workspaceRoot, dataDir } = makePaths();
    const written = writePlanMarkdown(dataDir, workspaceRoot, "mark-plan", buildValidPlan());
    const refs = ["W1-A-T1", "W1-A-T2", "W1-A-T3"].map((id) => `${written.planRef}#${id}`);

    const first = markPlanTasksComplete(dataDir, refs);
    const second = markPlanTasksComplete(dataDir, refs);

    expect(first.completed).toEqual(refs);
    expect(second.completed).toEqual([]);
    expect(second.alreadyCompleted).toEqual(refs);
    expect(readPlanMarkdown(dataDir, written.planRef).lint.tasks.filter((task) => task.completed).map((task) => task.id))
      .toEqual(["W1-A-T1", "W1-A-T2", "W1-A-T3"]);
    expect(() => markPlanTasksComplete(dataDir, [refs[0]!, `${written.planRef}#W1-B-T1`]))
      .toThrow(/one lane/);
    expect(() => markPlanTasksComplete(dataDir, [refs[0]!, refs[0]!]))
      .toThrow(/duplicates/);
  });

  it("rejects a symlinked Plan file", () => {
    if (process.platform === "win32") return;
    const { root, workspaceRoot, dataDir } = makePaths();
    const written = writePlanMarkdown(dataDir, workspaceRoot, "unsafe-plan", buildValidPlan());
    const workspaceName = written.planRef.slice(0, written.planRef.lastIndexOf(":"));
    const planPath = path.join(dataDir, "workspaces", workspaceName, "plans", "unsafe-plan.md");
    const outside = path.join(root, "outside.md");
    rmSync(planPath);
    symlinkSync(outside, planPath);

    expect(() => readPlanMarkdown(dataDir, written.planRef)).toThrow(/not found or unsafe/);
  });

  it("rejects a symlinked Plans directory for reads and writes", () => {
    if (process.platform === "win32") return;
    const { root, workspaceRoot, dataDir } = makePaths();
    const written = writePlanMarkdown(dataDir, workspaceRoot, "unsafe-directory", buildValidPlan());
    const workspaceName = written.planRef.slice(0, written.planRef.lastIndexOf(":"));
    const plansPath = path.join(dataDir, "workspaces", workspaceName, "plans");
    const outside = path.join(root, "outside-plans");
    rmSync(plansPath, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, plansPath, "dir");

    expect(() => readPlanMarkdown(dataDir, written.planRef)).toThrow(/directory not found or unsafe/);
    expect(() => writePlanMarkdown(dataDir, workspaceRoot, "another-plan", buildValidPlan())).toThrow(/Unsafe Fleet directory/);
  });
});

const CANONICAL_FULL_PLAN_POLICY =
  "- Full-plan execution: unavailable; dispatch explicit same-Lane TaskRefs only";
const LEGACY_FULL_PLAN_POLICY =
  "- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only";

function buildLegacyPlan(): string {
  return buildValidPlan().replace(CANONICAL_FULL_PLAN_POLICY, LEGACY_FULL_PLAN_POLICY);
}

function seedLegacyPlan(
  dataDir: string,
  workspaceRoot: string,
  planId: string,
): { planRef: string } {
  const written = writePlanMarkdown(dataDir, workspaceRoot, planId, buildValidPlan());
  expect(written.written).toBe(true);
  const workspaceName = written.planRef.slice(0, written.planRef.lastIndexOf(":"));
  const planPath = path.join(dataDir, "workspaces", workspaceName, "plans", `${planId}.md`);
  writeFileSync(planPath, buildLegacyPlan());
  return { planRef: written.planRef };
}

function makePaths(): { dataDir: string; root: string; workspaceRoot: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-plans-"));
  cleanupPaths.push(root);
  const workspaceRoot = path.join(root, "repo");
  const dataDir = path.join(root, "data");
  mkdirSync(workspaceRoot, { recursive: true });
  return { dataDir, root, workspaceRoot };
}
