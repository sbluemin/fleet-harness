import {
  getGrandFleetState,
  initGrandFleetState as initCoreGrandFleetState,
  type GrandFleetRole,
  type GrandFleetState,
} from "@sbluemin/fleet-core/admiralty";

export function getState(): GrandFleetState {
  return getGrandFleetState() as GrandFleetState;
}

export function initGrandFleetState(role: GrandFleetRole): void {
  initCoreGrandFleetState(role, {
    fleetId: role === "fleet" ? (process.env.FLEET_HARNESS_ID ?? null) : null,
    designation: role === "fleet" ? (process.env.FLEET_HARNESS_DESIGNATION ?? null) : null,
    socketPath: process.env.PI_GRAND_FLEET_SOCK ?? null,
    activeMissionId: null,
    activeMissionObjective: null,
  });
}
