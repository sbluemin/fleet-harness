import {
  CLI_DISPLAY_NAMES as CORE_CLI_DISPLAY_NAMES,
  TASKFORCE_CLI_TYPES as CORE_TASKFORCE_CLI_TYPES,
  getConfiguredTaskForceBackendsFromSnapshot as getCoreConfiguredTaskForceBackendsFromSnapshot,
  readStatesSnapshot as readCoreStatesSnapshot,
  type FleetStoreSnapshot,
  type TaskForceCliType,
} from "@sbluemin/fleet-carriers";

import {
  PANEL_DIM_COLOR as CORE_PANEL_DIM_COLOR,
  SPINNER_FRAMES as CORE_SPINNER_FRAMES,
  SYM_INDICATOR as CORE_SYM_INDICATOR,
  SYM_THINKING as CORE_SYM_THINKING,
  TASKFORCE_BADGE_COLOR as CORE_TASKFORCE_BADGE_COLOR,
} from "../admiral/constants.js";

export type { FleetStoreSnapshot };

export const ANSI_RESET = "\x1b[0m";

export function SPINNER_FRAMES(): readonly string[] {
  return CORE_SPINNER_FRAMES;
}

export function PANEL_DIM_COLOR(): string {
  return CORE_PANEL_DIM_COLOR;
}

export function TASKFORCE_BADGE_COLOR(): string {
  return CORE_TASKFORCE_BADGE_COLOR;
}

export function SYM_INDICATOR(): string {
  return CORE_SYM_INDICATOR;
}

export function SYM_THINKING(): string {
  return CORE_SYM_THINKING;
}

export function CLI_DISPLAY_NAMES(): Record<string, string> {
  return CORE_CLI_DISPLAY_NAMES;
}

export function TASKFORCE_CLI_TYPES(): readonly TaskForceCliType[] {
  return CORE_TASKFORCE_CLI_TYPES;
}

export function readStatesSnapshot(): FleetStoreSnapshot {
  return readCoreStatesSnapshot();
}

export function getConfiguredTaskForceBackendsFromSnapshot(
  snapshot: FleetStoreSnapshot,
  carrierId: string,
): readonly TaskForceCliType[] {
  return getCoreConfiguredTaskForceBackendsFromSnapshot(snapshot, carrierId);
}
