import { describe, expect, it } from "vitest";

import { buildAgentPlanToolRegistrations } from "../server/agent.js";

describe("Console Terminal host Plan tool composition", () => {
  it("registers all Plan authorities as host agent tools with no executor registration", () => {
    const registrations = buildAgentPlanToolRegistrations("/tmp/fleet-terminal-plan-tools");

    expect(registrations.extraAgentTools.map((spec) => spec.id)).toEqual([
      "plan_read",
      "plan_write",
      "plan_verify",
      "plan_mark_tasks",
    ]);
    expect("extraExecutorTools" in registrations).toBe(false);
  });
});
