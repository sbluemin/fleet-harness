import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";

import { CarrierRosterLine } from "../components/fleet/carrier-roster-line.js";
import { FleetStatusSection } from "../components/fleet/fleet-status-section.js";
import { JobsLine } from "../components/fleet/jobs-line.js";
import type { FleetPtySection } from "./types.js";

export function createDefaultFleetPtySections(rt: FleetCoreRuntimeContext): FleetPtySection[] {
  return [
    { component: new FleetStatusSection({ rt }), id: "fleet-status-section" },
    { component: new CarrierRosterLine(rt), id: "carrier-roster-line" },
    { component: new JobsLine(rt), id: "jobs-line" },
  ];
}

