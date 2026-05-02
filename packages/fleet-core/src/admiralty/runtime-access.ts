import type {
  AdmiraltyRuntimeState,
  FleetRuntimeState,
  GrandFleetRole,
  GrandFleetState,
} from "./types.js";
import {
  GRAND_FLEET_ADMIRALTY_RUNTIME_KEY,
  GRAND_FLEET_FLEET_RUNTIME_KEY,
  GRAND_FLEET_STATE_KEY,
} from "./types.js";

export interface GrandFleetStateInit {
  activeMissionId?: string | null;
  activeMissionObjective?: string | null;
  designation?: string | null;
  fleetId?: string | null;
  socketPath?: string | null;
  totalCost?: number;
}

export function getGrandFleetState(): GrandFleetState | null {
  return ((globalThis as Record<string, unknown>)[GRAND_FLEET_STATE_KEY] ?? null) as GrandFleetState | null;
}

export function initGrandFleetState(role: GrandFleetRole, init: GrandFleetStateInit = {}): void {
  if (getGrandFleetState()) return;
  (globalThis as Record<string, unknown>)[GRAND_FLEET_STATE_KEY] = {
    role,
    fleetId: init.fleetId ?? null,
    designation: init.designation ?? null,
    socketPath: init.socketPath ?? null,
    connectedFleets: new Map(),
    totalCost: init.totalCost ?? 0,
    activeMissionId: init.activeMissionId ?? null,
    activeMissionObjective: init.activeMissionObjective ?? null,
  } satisfies GrandFleetState;
}

export function getAdmiraltyRuntime(): AdmiraltyRuntimeState | null {
  return ((globalThis as Record<string, unknown>)[GRAND_FLEET_ADMIRALTY_RUNTIME_KEY] ?? null) as AdmiraltyRuntimeState | null;
}

export function setAdmiraltyRuntime(runtime: AdmiraltyRuntimeState): void {
  (globalThis as Record<string, unknown>)[GRAND_FLEET_ADMIRALTY_RUNTIME_KEY] = runtime;
}

export function clearAdmiraltyRuntime(): void {
  delete (globalThis as Record<string, unknown>)[GRAND_FLEET_ADMIRALTY_RUNTIME_KEY];
}

export function getFleetRuntime(): FleetRuntimeState | null {
  return ((globalThis as Record<string, unknown>)[GRAND_FLEET_FLEET_RUNTIME_KEY] ?? null) as FleetRuntimeState | null;
}

export function setFleetRuntime(runtime: FleetRuntimeState): void {
  (globalThis as Record<string, unknown>)[GRAND_FLEET_FLEET_RUNTIME_KEY] = runtime;
}
