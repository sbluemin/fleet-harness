import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";
import type { Component, FleetPtySection } from "@sbluemin/fleet-tui/pty";

import { renderCarrierJobHud } from "./job-bar-renderer.js";
import { getActiveJobs, getPanelRuns, getState } from "./job-bar-state.js";

export function createJobBarSections(rt: FleetCoreRuntimeContext): FleetPtySection[] {
  return [
    { component: new JobBarStripSection(rt), id: "job-bar-strip" },
    { component: new JobBarDetailSection(rt), id: "job-bar-detail" },
  ];
}

class JobBarStripSection implements Component {
  constructor(private readonly rt: FleetCoreRuntimeContext) {}

  invalidate(): void {}

  render(width: number): string[] {
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

  render(width: number): string[] {
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
