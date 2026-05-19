import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";
import type { Component, FleetPtySection } from "@sbluemin/fleet-tui/pty";

import { renderCarrierJobHud } from "./job-bar-renderer.js";
import { getActiveJobs, getPanelRuns, getState, isJobBarStateRuntimeBound } from "./job-bar-state.js";

const MAX_WIDGET_LINES = 10;

export function createJobBarSections(rt: FleetCoreRuntimeContext): FleetPtySection[] {
  return [
    { component: new JobBarStripSection(rt), id: "job-bar-strip" },
    { component: new JobBarDetailSection(rt), id: "job-bar-detail" },
  ];
}

class JobBarStripSection implements Component {
  constructor(private readonly rt: FleetCoreRuntimeContext) {}

  invalidate(): void {}

  desiredHeight(): number {
    return 1;
  }

  render(width: number): string[] {
    if (!isJobBarStateRuntimeBound()) return [];
    const state = getState();
    return renderCarrierJobHud({
      frame: state.frame,
      jobs: getActiveJobs(),
      mode: "strip",
      rt: this.rt,
      runs: getPanelRuns(),
      width,
    });
  }
}

class JobBarDetailSection implements Component {
  constructor(private readonly rt: FleetCoreRuntimeContext) {}

  invalidate(): void {}

  desiredHeight(): number {
    if (!isJobBarStateRuntimeBound()) return 0;
    const state = getState();
    if (state.widgetMode !== "expanded") return 0;
    const activeJobs = getActiveJobs();
    if (activeJobs.length === 0) return 1;
    const visibleCarrierCount = new Set(activeJobs.map((job) => job.ownerCarrierId)).size;
    const extraTrackRows = activeJobs.reduce((rows, job) => rows + (job.kind === "carrier" && job.tracks.length === 1 ? 0 : job.tracks.length), 0);
    const requestedRows = visibleCarrierCount + activeJobs.length + extraTrackRows;
    return Math.min(MAX_WIDGET_LINES, requestedRows);
  }

  render(width: number): string[] {
    if (!isJobBarStateRuntimeBound()) return [];
    const state = getState();
    if (state.widgetMode !== "expanded") return [];
    return renderCarrierJobHud({
      frame: state.frame,
      jobs: getActiveJobs(),
      mode: "expanded",
      rt: this.rt,
      runs: getPanelRuns(),
      width,
    });
  }
}
