import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";

export function reconcileRuntimeState(rt: FleetCoreRuntimeContext): void {
  rt.admiral.carrier.setOfflineCarriers(rt.admiral.store.loadOfflineCarriers());
  rt.admiral.carrier.setTaskForceConfiguredCarriers(
    rt.admiral.store.getConfiguredTaskForceCarrierIdsFromSnapshot(
      rt.admiral.store.readStatesSnapshot(),
      rt.admiral.carrier.getRegisteredOrder(),
    ),
  );
}
