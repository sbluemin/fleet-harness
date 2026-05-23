import { getRegisteredOrder } from "@sbluemin/fleet-carriers";

import { getActiveProtocol } from "../admiral/protocols/index.js";
import { getCarrierRuntime } from "./instances.js";

export interface FleetRuntimeStatus {
  readonly activeProtocol: string;
  readonly carrierCount: number;
}

export function readFleetRuntimeStatus(): FleetRuntimeStatus {
  return {
    activeProtocol: getActiveProtocol().name,
    carrierCount: getRegisteredOrder(getCarrierRuntime().registry).length,
  };
}
