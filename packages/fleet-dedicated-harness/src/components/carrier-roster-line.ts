import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";
import { type Component, truncateToWidth, visibleWidth } from "@sbluemin/fleet-tui";

const ANSI_RESET = "\x1b[0m";
const SEGMENT_SEPARATOR = " │ ";
const MIN_TASK_FORCE_BACKENDS = 2;
const DISABLED_COLOR = "\x1b[38;2;169;169;169m";

export class CarrierRosterLine implements Component {
	constructor(private readonly rt: FleetCoreRuntimeContext) {}

	invalidate(): void {}

	render(width: number): string[] {
		const carrier = this.rt.admiral.carrier;
		const store = this.rt.admiral.store;
		const snapshot = store.readStatesSnapshot();
		const segments = carrier.getRegisteredOrder().map((carrierId) => {
			const online = carrier.isCarrierOnline(carrierId);
			const color = online ? carrier.resolveCarrierColor(carrierId) : DISABLED_COLOR;
			const name = carrier.resolveCarrierDisplayName(carrierId);
			const taskForceBackendCount = store.getConfiguredTaskForceBackendsFromSnapshot(snapshot, carrierId).length;
			return `${colorize(`○ ${name}`, color)}${formatBadges(
				this.rt,
				taskForceBackendCount,
				carrier.isSquadronCarrierEnabled(carrierId),
				online,
			)}`;
		});
		return [centerLine(segments.join(SEGMENT_SEPARATOR), width)];
	}
}

function formatBadges(
	rt: FleetCoreRuntimeContext,
	taskForceBackendCount: number,
	squadronEnabled: boolean,
	online: boolean,
): string {
	const tfBadgeColor = online ? rt.admiral.constants.TASKFORCE_BADGE_COLOR : DISABLED_COLOR;
	const sqBadgeColor = online ? rt.admiral.constants.SQUADRON_BADGE_COLOR : DISABLED_COLOR;
	const tfBadge = taskForceBackendCount >= MIN_TASK_FORCE_BACKENDS
		? ` ${tfBadgeColor}[TF:${taskForceBackendCount}]${ANSI_RESET}`
		: "";
	const sqBadge = squadronEnabled ? ` ${sqBadgeColor}[SQ]${ANSI_RESET}` : "";
	return `${tfBadge}${sqBadge}`;
}

function colorize(text: string, color: string | undefined): string {
	if (!color) return text;
	return `${color}${text}${ANSI_RESET}`;
}

function fitLine(line: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

function centerLine(line: string, width: number): string {
	if (width <= 0) return "";
	const padding = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
	return fitLine(`${" ".repeat(padding)}${line}`, width);
}
