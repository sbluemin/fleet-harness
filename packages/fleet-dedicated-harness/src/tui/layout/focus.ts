import type { FleetInputMode } from "../../input/modes.js";

export interface FocusState {
  readonly mode: FleetInputMode;
}

export function createFocusState(mode: FleetInputMode): FocusState {
  return { mode };
}

