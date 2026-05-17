import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";
import { type Component, truncateToWidth, visibleWidth } from "@sbluemin/fleet-tui";

const UNAVAILABLE_LABEL = "└─ jobs status unavailable";

export class JobsLine implements Component {
	constructor(private readonly rt: FleetCoreRuntimeContext) {}

	invalidate(): void {}

	render(width?: number): string[] {
		const activeCount = getActiveJobCount(this.rt);
		const line =
			activeCount === undefined
				? UNAVAILABLE_LABEL
				: activeCount === 0
					? "└─ No active jobs"
					: `└─ ${activeCount} active job(s)`;
		return [fitLine(line, width)];
	}
}

function getActiveJobCount(rt: FleetCoreRuntimeContext): number | undefined {
	try {
		const response = rt.admiral.carrierJobs.dispatchCarrierJobsAction({ action: "list" });
		return response.active?.length ?? 0;
	} catch {
		return undefined;
	}
}

function fitLine(line: string, width: number | undefined): string {
	if (width === undefined || width <= 0) return line;
	return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}
