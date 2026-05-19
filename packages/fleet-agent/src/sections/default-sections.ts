import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";
import type { Component, FleetPtySection } from "@sbluemin/fleet-tui/pty";

import { CarrierRosterLine } from "./carrier-roster-line.js";
import { FleetStatusSection } from "./fleet-status-section.js";
import { JobsLine } from "./jobs-line.js";

export function createDefaultFleetPtySections(rt: FleetCoreRuntimeContext): FleetPtySection[] {
  return [
    { component: new FleetStatusSection({ rt }), id: "fleet-status-section" },
    { component: new CarrierRosterLine(rt), id: "carrier-roster-line" },
    { component: new JobsLine(rt), id: "jobs-line" },
  ];
}

export function createDefaultFleetPtyComponent(sections: readonly FleetPtySection[]): Component {
  return {
    invalidate(): void {
      for (const section of sections) {
        section.component.invalidate();
      }
    },
    render(width: number): string[] {
      return sections.flatMap((section) => section.component.render(width));
    },
  };
}
