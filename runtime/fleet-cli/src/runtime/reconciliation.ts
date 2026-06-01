import {
  type CarrierRuntime,
  getConfiguredTaskForceCarrierIdsFromSnapshot,
  getRegisteredOrder,
  readCarriersSnapshot,
  setTaskForceConfiguredCarriers,
} from "@dotobokuri/fleet-carriers";

export function reconcileRuntimeState(carrierRuntime: CarrierRuntime): void {
  const registry = carrierRuntime.registry;
  setTaskForceConfiguredCarriers(
    registry,
    getConfiguredTaskForceCarrierIdsFromSnapshot(
      readCarriersSnapshot(),
      getRegisteredOrder(registry),
    ),
  );
}
