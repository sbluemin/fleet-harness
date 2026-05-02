import { describe, expect, it } from "vitest";

import { buildCarrierResultSystemReminder, type CarrierJobSummary } from "../../../src/services/job/index.js";

const BASE_SUMMARY: CarrierJobSummary = {
  jobId: "sortie:1",
  tool: "carriers_sortie",
  status: "done",
  startedAt: 1,
  finishedAt: 2,
  carriers: ["genesis"],
  summary: "first full output must not appear",
};

describe("buildCarrierResultSystemReminder", () => {
  it("matches the previous single carrier completion push envelope", () => {
    expect(buildCarrierResultSystemReminder({
      jobId: "sortie:1",
      kind: "carrier",
      status: "done",
      summary: BASE_SUMMARY,
      label: "Genesis",
    })).toBe([
      '<system-reminder source="carrier-completion">',
      "[carrier:result]",
      "- sortie:1: first full output must not appear",
      "  kind=carrier status=done label=Genesis",
      "</system-reminder>",
    ].join("\n"));
  });

  it("includes squadron status and error metadata", () => {
    const summary = { ...BASE_SUMMARY, jobId: "squadron:2", tool: "carrier_squadron" as const, status: "error" as const, summary: "squadron failed" };

    const reminder = buildCarrierResultSystemReminder({
      jobId: "squadron:2",
      kind: "squadron",
      status: "error",
      summary,
      error: "boom",
      label: "2 subtasks",
    });

    expect(reminder).toContain("[carrier:result]");
    expect(reminder).toContain("kind=squadron");
    expect(reminder).toContain("status=error");
    expect(reminder).toContain("error=boom");
  });

  it("includes taskforce backend labels", () => {
    const summary = { ...BASE_SUMMARY, jobId: "taskforce:3", tool: "carrier_taskforce" as const, summary: "taskforce done" };

    const reminder = buildCarrierResultSystemReminder({
      jobId: "taskforce:3",
      kind: "taskforce",
      status: "done",
      summary,
      taskforceBackend: "claude-zai, codex",
      label: "2 backends",
    });

    expect(reminder).toContain("[carrier:result]");
    expect(reminder).toContain("kind=taskforce");
    expect(reminder).toContain("backend=claude-zai, codex");
  });
});
