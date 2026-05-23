import {
  type CarrierRuntime,
  getConfiguredTaskForceCarrierIdsFromSnapshot,
  getRegisteredOrder,
  readStatesSnapshot,
  setTaskForceConfiguredCarriers,
} from "@sbluemin/fleet-carriers";

export function reconcileRuntimeState(carrierRuntime: CarrierRuntime): void {
  const registry = carrierRuntime.registry;
  setTaskForceConfiguredCarriers(
    registry,
    getConfiguredTaskForceCarrierIdsFromSnapshot(
      readStatesSnapshot(),
      getRegisteredOrder(registry),
    ),
  );
}
