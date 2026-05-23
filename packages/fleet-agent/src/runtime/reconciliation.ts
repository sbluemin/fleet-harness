import {
  getConfiguredTaskForceCarrierIdsFromSnapshot,
  getRegisteredOrder,
  readStatesSnapshot,
  setTaskForceConfiguredCarriers,
} from "@sbluemin/fleet-carriers";

import { getCarrierRuntime } from "./instances.js";

export function reconcileRuntimeState(): void {
  const registry = getCarrierRuntime().registry;
  setTaskForceConfiguredCarriers(
    registry,
    getConfiguredTaskForceCarrierIdsFromSnapshot(
      readStatesSnapshot(),
      getRegisteredOrder(registry),
    ),
  );
}
