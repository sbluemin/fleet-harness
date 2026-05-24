export type FleetInputMode = "MIRROR" | "DEDICATED";

export function toggleFleetInputMode(mode: FleetInputMode): FleetInputMode {
  return mode === "MIRROR" ? "DEDICATED" : "MIRROR";
}

