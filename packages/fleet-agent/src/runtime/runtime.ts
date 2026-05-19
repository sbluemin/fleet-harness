import "@sbluemin/fleet-carriers";

import os from "node:os";
import path from "node:path";

import { createFleetCoreRuntime, type FleetCoreRuntimeContext } from "@sbluemin/fleet-core";

import { reconcileRuntimeState } from "./reconciliation.js";

export type { FleetCoreRuntimeContext };

export async function bootRuntime(): Promise<FleetCoreRuntimeContext> {
	const dataDir = path.join(os.homedir(), ".fleet");
	const rt = createFleetCoreRuntime({ dataDir, bootMode: "normal" });

	reconcileRuntimeState(rt);

	return rt;
}
