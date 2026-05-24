import {
	getConfiguredTaskForceBackendsFromSnapshot,
	getRegisteredOrder,
	readStatesSnapshot,
	type CarrierRuntime,
} from "@dotobokuri/fleet-carriers";
import { centerLine, truncateToWidth, visibleWidth, type Component } from "../controls/index.js";

import { resolveCarrierColor, resolveCarrierDisplayName } from "../carrier-status/carrier-helpers.js";

const ANSI_RESET = "\x1b[0m";
const SEGMENT_SEPARATOR = " │ ";
const MIN_TASK_FORCE_BACKENDS = 2;

export class CarrierRosterLine implements Component {
	constructor(private readonly carrierRuntime: CarrierRuntime) {}

	invalidate(): void {}

	render(width: number): string[] {
		const snapshot = readStatesSnapshot();
		const registry = this.carrierRuntime.registry;
		const segments = getRegisteredOrder(registry).map((carrierId) => {
			const color = resolveCarrierColor(registry, carrierId);
			const name = resolveCarrierDisplayName(registry, carrierId);
			const taskForceBackendCount = getConfiguredTaskForceBackendsFromSnapshot(snapshot, carrierId).length;
			return `${colorize(`○ ${name}`, color)}${formatBadges(
				taskForceBackendCount,
			)}`;
		});
		return [centerLine(segments.join(SEGMENT_SEPARATOR), width)];
	}
}

function formatBadges(
	taskForceBackendCount: number,
): string {
	const tfBadge = taskForceBackendCount >= MIN_TASK_FORCE_BACKENDS
		? ` \x1b[38;2;100;180;255m[TF:${taskForceBackendCount}]${ANSI_RESET}`
		: "";
	return tfBadge;
}

function colorize(text: string, color: string | undefined): string {
	if (!color) return text;
	return `${color}${text}${ANSI_RESET}`;
}

function fitLine(line: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}
