import "@sbluemin/fleet-carriers";

import os from "node:os";
import path from "node:path";

import { createFleetCoreRuntime, type FleetCoreRuntimeContext } from "@sbluemin/fleet-core";

export type { FleetCoreRuntimeContext };

export async function bootRuntime(): Promise<FleetCoreRuntimeContext> {
	const dataDir = path.join(os.homedir(), ".fleet");
	const rt = createFleetCoreRuntime({ dataDir, bootMode: "normal" });

	rt.admiral.carrier.setOfflineCarriers(rt.admiral.store.loadOfflineCarriers());
	rt.admiral.carrier.setSquadronEnabledCarriers(rt.admiral.store.loadSquadronEnabled());
	rt.admiral.carrier.setTaskForceConfiguredCarriers(
		rt.admiral.store.getConfiguredTaskForceCarrierIdsFromSnapshot(
			rt.admiral.store.readStatesSnapshot(),
			rt.admiral.carrier.getRegisteredOrder(),
		),
	);

	return rt;
}
