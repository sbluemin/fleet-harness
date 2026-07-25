import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FLEET_PLAN_TOOL_IDS, getPlanToolSpecs } from "../src/agent-specs.js";
import { createPlanWorkspaceServerBindings } from "../src/bindings.js";
import { buildMultiWavePlan, buildValidPlan } from "./fixtures.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { force: true, recursive: true });
  }
});

describe("Fleet Plan agent specs", () => {
  it("exposes exactly the four authority-separated tools", () => {
    const specs = getPlanToolSpecs({ dataDir: "/tmp/fleet-plans-test" });
    expect([specs.read.id, specs.write.id, specs.markTasks.id, specs.verify.id])
      .toEqual(FLEET_PLAN_TOOL_IDS);
    expect(specs.write.description).toContain("Host-only");
    expect(specs.write.promptSnippet).toContain("Load plan-operations");
    expect(specs.write.guardrails).toContain("Host-only mutation surface; never expose this tool to a Carrier executor.");
    expect(specs.verify.description).toContain("Host-only");
    expect(specs.markTasks.description).toContain("Host-only");
    expect(specs.read.guardrails).toContain("Read-only: this tool never creates directories or mutates Plan state.");
  });

  it("returns a full Plan for plan_ref and a compact execution view for TaskRefs", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-plan-tools-"));
    cleanupPaths.push(root);
    const cwd = path.join(root, "repo");
    mkdirSync(cwd, { recursive: true });
    const dataDir = path.join(root, "data");
    const specs = getPlanToolSpecs({ dataDir });
    const serverBindings = createPlanWorkspaceServerBindings(dataDir, cwd);

    const write = await specs.write.execute({
      plan_id: "tool-plan",
      markdown: buildValidPlan(),
    }, { cwd, serverBindings });
    const planRef = (write as { plan_ref: string }).plan_ref;
    const taskRefs = ["W1-A-T1", "W1-A-T2", "W1-A-T3"].map((id) => `${planRef}#${id}`);
    const fullRead = await specs.read.execute({ plan_ref: planRef }, { cwd });
    const compactRead = await specs.read.execute({ plan_ref: planRef, task_refs: taskRefs }, { cwd });
    const taskOnlyRead = await specs.read.execute({ task_refs: taskRefs }, { cwd });

    expect(fullRead).toEqual(expect.objectContaining({
      read_mode: "full",
      markdown: buildValidPlan(),
      valid: true,
    }));
    expect(fullRead).not.toHaveProperty("sections");
    expect((fullRead as { lanes: unknown[] }).lanes[0]).not.toHaveProperty("integrationGate");
    expect(compactRead).toEqual(expect.objectContaining({
      read_mode: "execution",
      plan_ref: planRef,
      plan_context: expect.objectContaining({
        objective: "Build deterministic Fleet Plan storage and tools.",
        execution_topology: expect.stringContaining("Execution mode: Parallel"),
        acceptance_criteria: expect.stringContaining("Plan tools enforce their mutation authority"),
      }),
      lane_context: expect.objectContaining({
        lane_id: "W1-A",
        exact_write_set: ["packages/core-infra/src/workspace-dir/**"],
        eligible_concurrent_lane_ids: ["W1-B"],
        verification_static_checks: ["pnpm --filter @dotobokuri/core-infra test"],
      }),
      selected_tasks: taskRefs.map((taskRef, index) => expect.objectContaining({
        task_ref: taskRef,
        task_id: `W1-A-T${index + 1}`,
      })),
      valid: true,
    }));
    expect(compactRead).not.toHaveProperty("markdown");
    expect(compactRead).not.toHaveProperty("lanes");
    expect(compactRead).not.toHaveProperty("tasks");
    expect(JSON.stringify(compactRead)).not.toContain("Implement PlanRef parsing");
    expect(JSON.stringify(compactRead).length).toBeLessThan(JSON.stringify(fullRead).length * 0.8);
    expect(taskOnlyRead).toEqual(compactRead);
  });

  it("rejects inconsistent PlanRef and TaskRef selections", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-plan-tools-"));
    cleanupPaths.push(root);
    const cwd = path.join(root, "repo");
    mkdirSync(cwd, { recursive: true });
    const dataDir = path.join(root, "data");
    const specs = getPlanToolSpecs({ dataDir });
    const serverBindings = createPlanWorkspaceServerBindings(dataDir, cwd);
    const first = await specs.write.execute({ plan_id: "first-plan", markdown: buildValidPlan() }, { cwd, serverBindings });
    const second = await specs.write.execute({ plan_id: "second-plan", markdown: buildValidPlan() }, { cwd, serverBindings });
    const firstRef = (first as { plan_ref: string }).plan_ref;
    const secondRef = (second as { plan_ref: string }).plan_ref;

    const mismatch = await specs.read.execute({
      plan_ref: firstRef,
      task_refs: [`${secondRef}#W1-A-T1`],
    }, { cwd });
    const crossLane = await specs.read.execute({
      task_refs: [`${firstRef}#W1-A-T1`, `${firstRef}#W1-B-T1`],
    }, { cwd });
    const missingInput = await specs.read.execute({}, { cwd });

    expect(mismatch).toEqual(expect.objectContaining({ isError: true }));
    expect(JSON.stringify(mismatch)).toContain("plan_ref does not match task_refs PlanRef");
    expect(crossLane).toEqual(expect.objectContaining({ isError: true }));
    expect(JSON.stringify(crossLane)).toContain("Assigned TaskRefs must belong to one Lane");
    expect(missingInput).toEqual(expect.objectContaining({ isError: true }));
    expect(JSON.stringify(missingInput)).toContain("requires at least one of plan_ref or task_refs");
  });

  it("blocks TaskRef execution views for an invalid Plan", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-plan-tools-"));
    cleanupPaths.push(root);
    const cwd = path.join(root, "repo");
    const dataDir = path.join(root, "data");
    mkdirSync(cwd, { recursive: true });
    const specs = getPlanToolSpecs({ dataDir });
    const serverBindings = createPlanWorkspaceServerBindings(dataDir, cwd);
    const write = await specs.write.execute({ plan_id: "corrupt-plan", markdown: buildValidPlan() }, { cwd, serverBindings });
    const planRef = (write as { plan_ref: string }).plan_ref;
    const workspaceRef = planRef.slice(0, planRef.lastIndexOf(":"));
    writeFileSync(path.join(dataDir, "workspaces", workspaceRef, "plans", "corrupt-plan.md"), "# Objective\n\nCorrupt\n");

    const read = await specs.read.execute({ task_refs: [`${planRef}#W1-A-T1`] }, { cwd });

    expect(read).toEqual(expect.objectContaining({ isError: true }));
    expect(JSON.stringify(read)).toContain("Cannot resolve TaskRefs from invalid Plan");
  });

  it("preserves plan-wide progress while narrowing a later-wave execution view", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-plan-tools-"));
    cleanupPaths.push(root);
    const cwd = path.join(root, "repo");
    mkdirSync(cwd, { recursive: true });
    const dataDir = path.join(root, "data");
    const specs = getPlanToolSpecs({ dataDir });
    const serverBindings = createPlanWorkspaceServerBindings(dataDir, cwd);
    const write = await specs.write.execute({ plan_id: "multi-wave", markdown: buildMultiWavePlan() }, { cwd, serverBindings });
    const planRef = (write as { plan_ref: string }).plan_ref;
    await specs.markTasks.execute({
      task_refs: ["W1-A-T1", "W1-A-T2", "W1-A-T3"].map((id) => `${planRef}#${id}`),
    }, { cwd });

    const read = await specs.read.execute({
      task_refs: ["W2-A-T1", "W2-A-T2", "W2-A-T3"].map((id) => `${planRef}#${id}`),
    }, { cwd }) as {
      lane_context: { dependency_start_conditions: string[]; lane_id: string };
      plan_context: { current_progress: { lanes: Array<{ complete: boolean; lane_id: string }> } };
      selected_tasks: Array<{ task_id: string }>;
    };

    expect(read.lane_context).toEqual(expect.objectContaining({
      lane_id: "W2-A",
      dependency_start_conditions: ["W1-A and W1-B integration gates pass"],
    }));
    expect(read.plan_context.current_progress.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane_id: "W1-A", complete: true }),
      expect.objectContaining({ lane_id: "W1-B", complete: false }),
      expect.objectContaining({ lane_id: "W2-A", complete: false }),
    ]));
    expect(read.selected_tasks.map((task) => task.task_id)).toEqual(["W2-A-T1", "W2-A-T2", "W2-A-T3"]);
    expect(JSON.stringify(read)).not.toContain("Implement cwd sanitization");
  });

  it("marks resolved TaskRefs and reports Plan-state readiness only", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-plan-tools-"));
    cleanupPaths.push(root);
    const cwd = path.join(root, "repo");
    mkdirSync(cwd, { recursive: true });
    const dataDir = path.join(root, "data");
    const specs = getPlanToolSpecs({ dataDir });
    const serverBindings = createPlanWorkspaceServerBindings(dataDir, cwd);
    const write = await specs.write.execute({
      plan_id: "tool-plan",
      markdown: buildValidPlan(),
    }, { cwd, serverBindings });
    const planRef = (write as { plan_ref: string }).plan_ref;
    const taskRefs = ["W1-A-T1", "W1-A-T2", "W1-A-T3"].map((id) => `${planRef}#${id}`);

    await specs.markTasks.execute({ task_refs: taskRefs }, { cwd });
    const beforeAllComplete = await specs.verify.execute({ plan_ref: planRef }, { cwd });
    expect(beforeAllComplete).toEqual(expect.objectContaining({
      ready_for_host_verification: false,
      implementation_verified: false,
    }));

    await specs.markTasks.execute({
      task_refs: ["W1-B-T1", "W1-B-T2", "W1-B-T3"].map((id) => `${planRef}#${id}`),
    }, { cwd });
    const complete = await specs.verify.execute({ plan_ref: planRef }, { cwd });
    expect(complete).toEqual(expect.objectContaining({
      ready_for_host_verification: true,
      implementation_verified: false,
    }));
  });

  it("writes through the host-bound workspace rather than the tool cwd and fails closed without it", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-plan-tools-"));
    cleanupPaths.push(root);
    const workspaceRoot = path.join(root, "theater");
    const toolCwd = path.join(workspaceRoot, ".fleet", "worktrees", "topic");
    const dataDir = path.join(root, "data");
    mkdirSync(toolCwd, { recursive: true });
    const specs = getPlanToolSpecs({ dataDir });
    const serverBindings = createPlanWorkspaceServerBindings(dataDir, workspaceRoot);

    const written = await specs.write.execute({ plan_id: "bound-plan", markdown: buildValidPlan() }, { cwd: toolCwd, serverBindings });

    expect(Object.values(serverBindings)).not.toContain(workspaceRoot);
    expect(written).toEqual(expect.objectContaining({ ok: true, plan_ref: expect.stringMatching(/:bound-plan$/) }));
    expect((written as { plan_ref: string }).plan_ref).toContain(workspaceRoot.replace(/[^a-zA-Z0-9]/g, "-"));
    expect(existsSync(path.join(dataDir, "workspaces", toolCwd.replace(/[^a-zA-Z0-9]/g, "-")))).toBe(false);
  });

  it("rejects missing, empty, and malformed Plan bindings before creating storage", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-plan-tools-"));
    cleanupPaths.push(root);
    const toolCwd = path.join(root, "worktree");
    const dataDir = path.join(root, "data");
    mkdirSync(toolCwd, { recursive: true });
    const specs = getPlanToolSpecs({ dataDir });

    for (const serverBindings of [
      undefined,
      Object.freeze({}),
      Object.freeze({ "fleet-plans.workspace-ref": "" }),
      Object.freeze({ "fleet-plans.workspace-ref": "  " }),
      Object.freeze({ "fleet-plans.workspace-ref": "not/a-workspace-ref" }),
      Object.freeze({ "fleet-plans.workspace-ref": "nonexistent-workspace-ref" }),
    ]) {
      const result = await specs.write.execute({ plan_id: "missing-binding", markdown: buildValidPlan() }, { cwd: toolCwd, serverBindings });
      expect(result).toEqual(expect.objectContaining({ isError: true }));
      expect(JSON.stringify(result)).toContain("host-bound Plan workspace");
      expect(existsSync(dataDir)).toBe(false);
    }
  });
});
