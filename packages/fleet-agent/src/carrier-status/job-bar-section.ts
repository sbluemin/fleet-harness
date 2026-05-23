import type { Component, FleetPtySection } from "@sbluemin/fleet-tui/pty";

import { renderCarrierJobHud, renderCarrierJobHudStrip } from "./job-bar-renderer.js";
import type { JobBarState } from "./job-bar-state.js";

const MAX_WIDGET_LINES = 10;

export function createJobBarSections(jobBarState: JobBarState): FleetPtySection[] {
  return [
    { component: new JobBarStripSection(jobBarState), id: "job-bar-strip" },
    { component: new JobBarDetailSection(jobBarState), id: "job-bar-detail" },
  ];
}

class JobBarStripSection implements Component {
  constructor(private readonly jobBarState: JobBarState) {}

  invalidate(): void {}

  desiredHeight(): number {
    if (!this.jobBarState.isRuntimeBound()) return 0;
    return 1;
  }

  render(width: number): string[] {
    if (!this.jobBarState.isRuntimeBound()) return [];
    const state = this.jobBarState.getState();
    return renderCarrierJobHudStrip({
      carrierRuntime: this.jobBarState.carrierRuntime,
      frame: state.frame,
      jobs: this.jobBarState.getActiveJobs(),
      keyboardProtocol: this.jobBarState.getKeyboardProtocol?.(),
      runs: this.jobBarState.getPanelRuns(),
      width,
    });
  }
}

class JobBarDetailSection implements Component {
  constructor(private readonly jobBarState: JobBarState) {}

  invalidate(): void {}

  desiredHeight(): number {
    if (!this.jobBarState.isRuntimeBound()) return 0;
    const activeJobs = this.jobBarState.getActiveJobs();
    if (activeJobs.length === 0) return 0;
    const visibleCarrierCount = new Set(activeJobs.map((job) => job.ownerCarrierId)).size;
    const extraTrackRows = activeJobs.reduce((rows, job) => rows + (job.kind === "carrier" && job.tracks.length === 1 ? 0 : job.tracks.length), 0);
    const requestedRows = visibleCarrierCount + activeJobs.length + extraTrackRows;
    return Math.min(MAX_WIDGET_LINES, requestedRows);
  }

  render(width: number): string[] {
    if (!this.jobBarState.isRuntimeBound()) return [];
    const state = this.jobBarState.getState();
    return renderCarrierJobHud({
      carrierRuntime: this.jobBarState.carrierRuntime,
      frame: state.frame,
      jobs: this.jobBarState.getActiveJobs(),
      runs: this.jobBarState.getPanelRuns(),
      width,
    });
  }
}
