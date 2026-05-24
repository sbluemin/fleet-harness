import { truncateToWidth, visibleWidth, type Component } from "../controls/index.js";

import { FLEET_ACTION_COLOR, FLEET_ACTION_LABEL } from "../admiral/protocols/index.js";

export interface FleetStatusSectionOptions {
	readonly native?: boolean;
}

const ANSI_RESET = "\x1b[0m";
const DIM_COLOR = "\x1b[38;5;244m";
const BORDER_CHAR = "─";
const PROTOCOL_ICON = "⚓";

export class FleetStatusSection implements Component {
	constructor(private readonly options: FleetStatusSectionOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.options.native) {
			return [renderBorder(width, DIM_COLOR)];
		}
		return [renderStatusLine(width, FLEET_ACTION_COLOR, FLEET_ACTION_LABEL)];
	}
}

function renderStatusLine(width: number, protocolColor: string, protocolLabel: string): string {
	if (width <= 0) return "";
	const centerBlock = colorize(` ${PROTOCOL_ICON} ${protocolLabel} `, protocolColor);
	const centerWidth = visibleWidth(centerBlock);
	if (centerWidth >= width) return truncateToWidth(centerBlock, width);

	const remainingWidth = width - centerWidth;
	const leftWidth = Math.floor(remainingWidth / 2);
	const rightWidth = remainingWidth - leftWidth;
	return renderBorder(leftWidth, protocolColor) + centerBlock + renderBorder(rightWidth, protocolColor);
}

function colorize(text: string, color: string): string {
	return `${color}${text}${ANSI_RESET}`;
}

function renderBorder(width: number, color: string): string {
	if (width <= 0) return "";
	return colorize(BORDER_CHAR.repeat(width), color);
}
