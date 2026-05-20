import "@sbluemin/fleet-carriers";

import { admiral, TASKFORCE_CLI_TYPES as CORE_TASKFORCE_CLI_TYPES } from "@sbluemin/fleet-core";
import type { FleetStoreSnapshot, TaskForceCliType } from "@sbluemin/fleet-core";

export type { FleetStoreSnapshot };

export const ANSI_RESET = "\x1b[0m";

export function SPINNER_FRAMES(): readonly string[] {
  return admiral.constants.SPINNER_FRAMES;
}

export function PANEL_DIM_COLOR(): string {
  return admiral.constants.PANEL_DIM_COLOR;
}

export function TASKFORCE_BADGE_COLOR(): string {
  return admiral.constants.TASKFORCE_BADGE_COLOR;
}

export function SYM_INDICATOR(): string {
  return admiral.constants.SYM_INDICATOR;
}

export function SYM_THINKING(): string {
  return admiral.constants.SYM_THINKING;
}

export function CLI_DISPLAY_NAMES(): Record<string, string> {
  return admiral.constants.CLI_DISPLAY_NAMES;
}

export function TASKFORCE_CLI_TYPES(): readonly TaskForceCliType[] {
  return CORE_TASKFORCE_CLI_TYPES;
}

export function readStatesSnapshot(): FleetStoreSnapshot {
  return admiral.store.readStatesSnapshot();
}

export function getConfiguredTaskForceBackendsFromSnapshot(
  snapshot: FleetStoreSnapshot,
  carrierId: string,
): readonly TaskForceCliType[] {
  return admiral.store.getConfiguredTaskForceBackendsFromSnapshot(snapshot, carrierId);
}
