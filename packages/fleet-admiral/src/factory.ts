export interface FleetAdmiral {
  readonly kind: "fleet-admiral";
}

export type FleetAdmiralConfig = Record<string, never>;

export interface FleetAdmiralDeps {
  readonly carrierRuntime?: unknown;
  readonly config?: FleetAdmiralConfig;
  readonly infraServices?: unknown;
}

export function createFleetAdmiral(_deps: FleetAdmiralDeps = {}): FleetAdmiral {
  return {
    kind: "fleet-admiral"
  };
}
