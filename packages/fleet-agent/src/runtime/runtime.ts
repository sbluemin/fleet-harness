import "@sbluemin/fleet-carriers";
// fleet-wiki agent specs는 모듈 로드 시 executor tool을 self-register한다.
import "@sbluemin/fleet-wiki";

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
