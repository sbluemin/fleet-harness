import { describe, expect, it } from "vitest";

import { renderCarrierJobHud } from "../src/carrier-status/job-bar-renderer.js";
import type { PanelJob, PanelRunViewModelSource } from "../src/carrier-status/job-bar-view-model.js";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

describe("job bar renderer", () => {
  it("groups same-carrier dispatches under one carrier header with independent previews", () => {
    const runs = new Map<string, PanelRunViewModelSource>([
      ["run:first", { runId: "run:first", status: "stream", blocks: [{ type: "text", text: "alpha preview" }] }],
      ["run:second", { runId: "run:second", status: "stream", blocks: [{ type: "text", text: "beta preview" }] }],
    ]);

    const text = stripAnsi(renderCarrierJobHud({
      frame: 0,
      jobs: [
        buildDispatchJob("carrier:first", "run:first", "Audit stream identity", 1000),
        buildDispatchJob("carrier:second", "run:second", "Patch renderer grouping", 1001),
      ],
      mode: "expanded",
      rt: buildRuntime(),
      runs,
      width: 100,
    }).join("\n"));

    expect(text.match(/Carrier Genesis/g)).toHaveLength(1);
    expect(text).toContain("Audit stream identity");
    expect(text).toContain("Patch renderer grouping");
    expect(text).toContain("alpha preview");
    expect(text).toContain("beta preview");
  });
});

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

function buildRuntime(): any {
  return {
    admiral: {
      carrier: {
        getRegisteredOrder: () => ["genesis"],
        isCarrierOnline: () => true,
        resolveCarrierColor: () => "",
        resolveCarrierDisplayName: () => "Genesis",
        resolveCarrierRgb: () => [120, 180, 255],
      },
      constants: {
        CLI_DISPLAY_NAMES: { codex: "Codex" },
        PANEL_DIM_COLOR: "",
        SPINNER_FRAMES: ["◉"],
        SYM_INDICATOR: "●",
        SYM_THINKING: "✦",
        TASKFORCE_BADGE_COLOR: "",
      },
      store: {
        getConfiguredTaskForceBackendsFromSnapshot: () => [],
        readStatesSnapshot: () => ({}),
      },
    },
  };
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
