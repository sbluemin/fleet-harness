import type { FleetInputMode } from "./types.js";

export type { FleetInputMode } from "./types.js";

export function toggleFleetInputMode(mode: FleetInputMode): FleetInputMode {
  return mode === "MIRROR" ? "DEDICATED" : "MIRROR";
}
