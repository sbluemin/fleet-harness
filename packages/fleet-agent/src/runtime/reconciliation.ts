import {
  type CarrierRuntime,
  getConfiguredTaskForceCarrierIdsFromSnapshot,
  getRegisteredOrder,
  readStatesSnapshot,
  setTaskForceConfiguredCarriers,
} from "@dotobokuri/fleet-carriers";

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
