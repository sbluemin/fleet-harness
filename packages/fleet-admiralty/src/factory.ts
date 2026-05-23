import type { FleetAdmiral } from "@sbluemin/fleet-admiral";

import { createGrandFleetRuntimeAccess, type GrandFleetRuntimeAccess } from "./runtime-access.js";

export interface FleetAdmiralty {
  readonly kind: "fleet-admiralty";
  readonly runtimeAccess: GrandFleetRuntimeAccess;
}

export interface FleetAdmiraltyConfig {
  readonly fleetAdmiral?: FleetAdmiral;
}

export interface FleetAdmiraltyDeps {
  readonly config?: FleetAdmiraltyConfig;
  readonly fleetAdmiral?: FleetAdmiral;
}

export function createFleetAdmiralty(_deps: FleetAdmiraltyDeps = {}): FleetAdmiralty {
  return {
    kind: "fleet-admiralty",
    runtimeAccess: createGrandFleetRuntimeAccess()
  };
}
