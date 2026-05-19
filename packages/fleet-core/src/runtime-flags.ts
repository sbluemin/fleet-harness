export type BootMode = "dev" | "normal";

let fleetCoreBootMode: BootMode = "normal";

export function setFleetCoreBootMode(mode: BootMode): void {
  fleetCoreBootMode = mode;
}

export function getBootMode(): BootMode {
  return fleetCoreBootMode;
}
