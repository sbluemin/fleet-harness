import { getRegisteredOrder, type CarrierRuntime } from "@sbluemin/fleet-carriers";

import { getActiveProtocol } from "../admiral/protocols/index.js";

export interface FleetRuntimeStatus {
  readonly activeProtocol: string;
  readonly carrierCount: number;
}

export interface RuntimeProvider {
  readFleetRuntimeStatus(): FleetRuntimeStatus;
}

interface RuntimeProviderDeps {
  readonly carrierRuntime: CarrierRuntime;
}

export function createRuntimeProvider(deps: RuntimeProviderDeps): RuntimeProvider {
  return {
    readFleetRuntimeStatus() {
      return {
        activeProtocol: getActiveProtocol().name,
        carrierCount: getRegisteredOrder(deps.carrierRuntime.registry).length,
      };
    },
  };
}
