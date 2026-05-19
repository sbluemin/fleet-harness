import { admiral } from "@sbluemin/fleet-core";

export interface FleetRuntimeStatus {
  readonly activeProtocol: string;
  readonly carrierCount: number;
}

export function readFleetRuntimeStatus(): FleetRuntimeStatus {
  return {
    activeProtocol: admiral.protocols.getActiveProtocol().name,
    carrierCount: admiral.carrier.getRegisteredOrder().length,
  };
}
