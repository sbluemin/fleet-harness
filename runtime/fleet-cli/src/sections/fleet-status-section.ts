import { FLEET_ACTION_COLOR, FLEET_ACTION_LABEL } from "@dotobokuri/fleet-admiral";
import { paint } from "@dotobokuri/fleet-style";
import { DIM_COLOR } from "@dotobokuri/fleet-tui/core";

import { truncateToWidth, visibleWidth, type Component } from "../controls/index.js";

export interface FleetStatusSectionOptions {
	readonly getNative?: () => boolean;
	readonly native?: boolean;
}

const BORDER_CHAR = "─";
const PROTOCOL_ICON = "⚓";

export class FleetStatusSection implements Component {
	constructor(private readonly options: FleetStatusSectionOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.options.getNative?.() ?? this.options.native) {
			return [renderBorder(width, DIM_COLOR)];
		}
		return [renderStatusLine(width, FLEET_ACTION_COLOR, FLEET_ACTION_LABEL)];
	}
}

function renderStatusLine(width: number, protocolColor: string, protocolLabel: string): string {
	if (width <= 0) return "";
	const centerBlock = paint(protocolColor, ` ${PROTOCOL_ICON} ${protocolLabel} `, true);
	const centerWidth = visibleWidth(centerBlock);
	if (centerWidth >= width) return truncateToWidth(centerBlock, width);

	const remainingWidth = width - centerWidth;
	const leftWidth = Math.floor(remainingWidth / 2);
	const rightWidth = remainingWidth - leftWidth;
	return renderBorder(leftWidth, protocolColor) + centerBlock + renderBorder(rightWidth, protocolColor);
}

function renderBorder(width: number, color: string): string {
	if (width <= 0) return "";
	return paint(color, BORDER_CHAR.repeat(width), true);
}
