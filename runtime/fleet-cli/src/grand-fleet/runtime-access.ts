import type {
  AdmiraltyRuntimeState,
  FleetRuntimeState,
  GrandFleetRole,
  GrandFleetState,
} from "./types.js";

export interface GrandFleetStateInit {
  activeMissionId?: string | null;
  activeMissionObjective?: string | null;
  designation?: string | null;
  fleetId?: string | null;
  socketPath?: string | null;
  totalCost?: number;
}

export interface GrandFleetRuntimeAccess {
  state(): GrandFleetState | null;
  initState(role: GrandFleetRole, init?: GrandFleetStateInit): void;
  admiralty(): AdmiraltyRuntimeState | null;
  assignAdmiralty(runtime: AdmiraltyRuntimeState): void;
  clearAdmiralty(): void;
  fleet(): FleetRuntimeState | null;
  assignFleet(runtime: FleetRuntimeState): void;
}

export function createGrandFleetRuntimeAccess(): GrandFleetRuntimeAccess {
  let stateValue: GrandFleetState | null = null;
  let admiraltyValue: AdmiraltyRuntimeState | null = null;
  let fleetValue: FleetRuntimeState | null = null;

  return {
    state() {
      return stateValue;
    },
    initState(role, init = {}) {
      if (stateValue) return;
      stateValue = {
        role,
        fleetId: init.fleetId ?? null,
        designation: init.designation ?? null,
        socketPath: init.socketPath ?? null,
        connectedFleets: new Map(),
        totalCost: init.totalCost ?? 0,
        activeMissionId: init.activeMissionId ?? null,
        activeMissionObjective: init.activeMissionObjective ?? null,
      };
    },
    admiralty() {
      return admiraltyValue;
    },
    assignAdmiralty(runtime) {
      admiraltyValue = runtime;
    },
    clearAdmiralty() {
      admiraltyValue = null;
    },
    fleet() {
      return fleetValue;
    },
    assignFleet(runtime) {
      fleetValue = runtime;
    },
  };

}
