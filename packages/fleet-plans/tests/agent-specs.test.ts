import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FLEET_PLAN_TOOL_IDS, getPlanToolSpecs } from "../src/agent-specs.js";
import { buildValidPlan } from "./fixtures.js";

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
  });

  it("writes, resolves assigned TaskRefs, marks them, and reports Plan-state readiness only", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-plan-tools-"));
    cleanupPaths.push(root);
    const cwd = path.join(root, "repo");
    mkdirSync(cwd, { recursive: true });
    const specs = getPlanToolSpecs({ dataDir: path.join(root, "data") });

    const write = await specs.write.execute({
      plan_id: "tool-plan",
      markdown: buildValidPlan(),
    }, { cwd });
    const planRef = (write as { plan_ref: string }).plan_ref;
    const taskRefs = ["W1-A-T1", "W1-A-T2", "W1-A-T3"].map((id) => `${planRef}#${id}`);
    const read = await specs.read.execute({ task_refs: taskRefs }, { cwd });

    expect(read).toEqual(expect.objectContaining({
      assigned_lane: "W1-A",
      valid: true,
    }));

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
});
