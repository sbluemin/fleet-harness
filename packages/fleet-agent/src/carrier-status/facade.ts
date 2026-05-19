import "@sbluemin/fleet-carriers";

import { TASKFORCE_CLI_TYPES as CORE_TASKFORCE_CLI_TYPES } from "@sbluemin/fleet-core";
import type { FleetCoreRuntimeContext, FleetStoreSnapshot, TaskForceCliType } from "@sbluemin/fleet-core";

export type { FleetStoreSnapshot };

export const ANSI_RESET = "\x1b[0m";

export function SPINNER_FRAMES(rt: FleetCoreRuntimeContext): readonly string[] {
  return rt.admiral.constants.SPINNER_FRAMES;
}

export function PANEL_DIM_COLOR(rt: FleetCoreRuntimeContext): string {
  return rt.admiral.constants.PANEL_DIM_COLOR;
}

export function TASKFORCE_BADGE_COLOR(rt: FleetCoreRuntimeContext): string {
  return rt.admiral.constants.TASKFORCE_BADGE_COLOR;
}

export function SYM_INDICATOR(rt: FleetCoreRuntimeContext): string {
  return rt.admiral.constants.SYM_INDICATOR;
}

export function SYM_THINKING(rt: FleetCoreRuntimeContext): string {
  return rt.admiral.constants.SYM_THINKING;
}

export function CLI_DISPLAY_NAMES(rt: FleetCoreRuntimeContext): Record<string, string> {
  return rt.admiral.constants.CLI_DISPLAY_NAMES;
}

export function TASKFORCE_CLI_TYPES(): readonly TaskForceCliType[] {
  return CORE_TASKFORCE_CLI_TYPES;
}

export function readStatesSnapshot(rt: FleetCoreRuntimeContext): FleetStoreSnapshot {
  return rt.admiral.store.readStatesSnapshot();
}

export function getConfiguredTaskForceBackendsFromSnapshot(
  rt: FleetCoreRuntimeContext,
  snapshot: FleetStoreSnapshot,
  carrierId: string,
): readonly TaskForceCliType[] {
  return rt.admiral.store.getConfiguredTaskForceBackendsFromSnapshot(snapshot, carrierId);
}
