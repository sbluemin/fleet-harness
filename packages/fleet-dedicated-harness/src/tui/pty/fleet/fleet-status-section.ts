import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";

import { truncateToWidth, visibleWidth } from "../../primitives/text.js";
import type { Component } from "./api.js";

export interface FleetStatusSectionOptions {
	readonly rt: FleetCoreRuntimeContext;
}

const ANSI_RESET = "\x1b[0m";
const DIM_COLOR = "\x1b[38;5;244m";
const BORDER_CHAR = "─";
const STATUS_SEPARATOR = " │ ";

export class FleetStatusSection implements Component {
	constructor(private readonly options: FleetStatusSectionOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		const protocol = this.options.rt.admiral.protocols.getActiveProtocol();
		return [renderStatusLine(width, protocol.color ?? DIM_COLOR)];
	}
}

function renderStatusLine(width: number, protocolColor: string): string {
	if (width <= 0) return "";
	const center = colorize("Fleet Action Protocol", protocolColor);
	const centerBlock = `${renderSeparator(protocolColor)}${center}${renderSeparator(protocolColor)}`;
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

function renderSeparator(color: string): string {
	return colorize(STATUS_SEPARATOR, color);
}
