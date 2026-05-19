import { admiral } from "@sbluemin/fleet-core";
import { centerLine, truncateToWidth, visibleWidth, type Component } from "@sbluemin/fleet-tui/pty";

const ANSI_RESET = "\x1b[0m";
const SEGMENT_SEPARATOR = " │ ";
const MIN_TASK_FORCE_BACKENDS = 2;
const DISABLED_COLOR = "\x1b[38;2;169;169;169m";

export class CarrierRosterLine implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		const carrier = admiral.carrier;
		const store = admiral.store;
		const snapshot = store.readStatesSnapshot();
		const segments = carrier.getRegisteredOrder().map((carrierId) => {
			const online = carrier.isCarrierOnline(carrierId);
			const color = online ? carrier.resolveCarrierColor(carrierId) : DISABLED_COLOR;
			const name = carrier.resolveCarrierDisplayName(carrierId);
			const taskForceBackendCount = store.getConfiguredTaskForceBackendsFromSnapshot(snapshot, carrierId).length;
			return `${colorize(`○ ${name}`, color)}${formatBadges(
				taskForceBackendCount,
				online,
			)}`;
		});
		return [centerLine(segments.join(SEGMENT_SEPARATOR), width)];
	}
}

function formatBadges(
	taskForceBackendCount: number,
	online: boolean,
): string {
	const tfBadgeColor = online ? "\x1b[38;2;100;180;255m" : DISABLED_COLOR;
	const tfBadge = taskForceBackendCount >= MIN_TASK_FORCE_BACKENDS
		? ` ${tfBadgeColor}[TF:${taskForceBackendCount}]${ANSI_RESET}`
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
