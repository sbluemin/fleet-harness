import { afterEach, describe, expect, it } from "vitest";

import { createCarrierRuntime } from "@dotobokuri/fleet-carriers";

import { createJobBarSections } from "../src/carrier-status/job-bar-section.js";
import { renderCarrierJobHud } from "../src/carrier-status/job-bar-renderer.js";
import { createJobBarState, type JobBarState } from "../src/carrier-status/job-bar-state.js";
import type { PanelJob, PanelRunViewModelSource } from "../src/carrier-status/job-bar-view-model.js";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

afterEach(() => {
  currentJobBarState?.dispose();
  currentJobBarState = undefined;
});

describe("job bar renderer", () => {
  it("groups same-carrier dispatches under one carrier header with independent previews", () => {
    const runtime = createTestCarrierRuntime();
    const runs = new Map<string, PanelRunViewModelSource>([
      ["run:first", { runId: "run:first", status: "stream", blocks: [{ type: "text", text: "alpha preview" }] }],
      ["run:second", { runId: "run:second", status: "stream", blocks: [{ type: "text", text: "beta preview" }] }],
    ]);

    const text = stripAnsi(renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [
        buildDispatchJob("carrier:first", "run:first", "Audit stream identity", 1000),
        buildDispatchJob("carrier:second", "run:second", "Patch renderer grouping", 1001),
      ],
      runs,
      width: 100,
    }).join("\n"));

    expect(text.match(/Carrier Genesis/g)).toHaveLength(1);
    expect(text).toContain("Audit stream identity");
    expect(text).toContain("Patch renderer grouping");
    expect(text).toContain("alpha preview");
    expect(text).toContain("beta preview");
  });

  it("renders no empty-state text when there are no active jobs", () => {
    const runtime = createTestCarrierRuntime();
    const lines = renderCarrierJobHud({
      carrierRuntime: runtime,
      frame: 0,
      jobs: [],
      width: 100,
    });

    expect(lines).toEqual([]);
  });

  it("keeps the carrier strip visible and hides the detail section when there are no active jobs", () => {
    const state = createTestJobBarState();

    const sections = createJobBarSections(state);

    expect(sections.map(desiredHeight)).toEqual([1, 0]);
  });

  it("shows strip and detail sections together when at least one job is active", () => {
    const state = createTestJobBarState();
    state.getPanelJobs().set("carrier:first", buildDispatchJob("carrier:first", "run:first", "Audit stream identity", 1000));

    const sections = createJobBarSections(state);

    expect(sections.map(desiredHeight)).toEqual([1, 2]);
  });
});

let currentJobBarState: JobBarState | undefined;

function createTestCarrierRuntime(): ReturnType<typeof createCarrierRuntime> {
  const runtime = createCarrierRuntime();
  runtime.registerCarrierDefaults();
  return runtime;
}

function createTestJobBarState(): JobBarState {
  currentJobBarState = createJobBarState({ carrierRuntime: createTestCarrierRuntime() });
  return currentJobBarState;
}

function desiredHeight(section: ReturnType<typeof createJobBarSections>[number]): number | undefined {
  return section.component.desiredHeight?.(20);
}

function buildDispatchJob(jobId: string, runId: string, label: string, startedAt: number): PanelJob {
  return {
    jobId,
    kind: "carrier",
    label,
    ownerCarrierId: "genesis",
    startedAt,
    status: "active",
    tracks: [{
      displayCli: "genesis",
      displayName: "Genesis",
      kind: "carrier",
      runId,
      status: "stream",
      streamKey: "genesis",
      trackId: "genesis",
    }],
  };
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
