import { admiral } from "@sbluemin/fleet-core";

export function reconcileRuntimeState(): void {
  admiral.carrier.setTaskForceConfiguredCarriers(
    admiral.store.getConfiguredTaskForceCarrierIdsFromSnapshot(
      admiral.store.readStatesSnapshot(),
      admiral.carrier.getRegisteredOrder(),
    ),
  );
}
