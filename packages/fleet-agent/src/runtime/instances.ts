import type { CarrierRuntime } from "@sbluemin/fleet-carriers";

let activeCarrierRuntime: CarrierRuntime | null = null;

export function configureCarrierRuntime(runtime: CarrierRuntime | null): void {
	activeCarrierRuntime = runtime;
}

export function getCarrierRuntime(): CarrierRuntime {
	if (!activeCarrierRuntime) {
		throw new Error("Fleet carrier runtime is not configured");
	}
	return activeCarrierRuntime;
}
