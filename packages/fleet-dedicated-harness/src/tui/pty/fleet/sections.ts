import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";

import { CarrierRosterLine } from "./carrier-roster-line.js";
import type { Component } from "./component.js";
import { FleetStatusSection } from "./fleet-status-section.js";
import { JobsLine } from "./jobs-line.js";
import type { FleetPtySection } from "./types.js";

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
