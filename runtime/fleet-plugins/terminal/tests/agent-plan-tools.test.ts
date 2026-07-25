import { describe, expect, it } from "vitest";

import { buildAgentPlanToolRegistrations } from "../server/agent.js";

describe("Console Terminal host Plan tool composition", () => {
  it("registers host authorities as agent tools and only Ohio completion as an executor tool", () => {
    const registrations = buildAgentPlanToolRegistrations("/tmp/fleet-terminal-plan-tools");

    expect(registrations.extraAgentTools.map((spec) => spec.id)).toEqual([
      "plan_read",
      "plan_write",
      "plan_verify",
    ]);
    expect(registrations.extraExecutorTools.map(({ spec }) => spec.id)).toEqual([
      "plan_mark_tasks",
    ]);
    expect(registrations.extraExecutorTools[0]?.options).toEqual({ allowedScopes: [] });
  });
});
