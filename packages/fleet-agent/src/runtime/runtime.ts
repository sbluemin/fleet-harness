import "@sbluemin/fleet-carriers";
// fleet-wiki agent specs는 모듈 로드 시 executor tool을 self-register한다.
import "@sbluemin/fleet-wiki";

import os from "node:os";
import path from "node:path";

import { bootFleetCore, type FleetCoreShutdownHandle } from "@sbluemin/fleet-core";

import { reconcileRuntimeState } from "./reconciliation.js";

let shutdownHandle: FleetCoreShutdownHandle | null = null;

export async function bootRuntime(): Promise<void> {
	const dataDir = path.join(os.homedir(), ".fleet");
	shutdownHandle = bootFleetCore({ dataDir, bootMode: "normal" });

	reconcileRuntimeState();
}

export async function shutdownRuntime(): Promise<void> {
	const handle = shutdownHandle;
	shutdownHandle = null;
	await handle?.shutdown();
}
