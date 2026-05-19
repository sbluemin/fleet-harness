import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";

export interface FleetRuntimeStatus {
  readonly activeProtocol: string;
  readonly carrierCount: number;
}

export function readFleetRuntimeStatus(rt: FleetCoreRuntimeContext): FleetRuntimeStatus {
  return {
    activeProtocol: rt.admiral.protocols.getActiveProtocol().name,
    carrierCount: rt.admiral.carrier.getRegisteredOrder().length,
  };
}

