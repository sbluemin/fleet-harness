import { DIM_COLOR } from "../styles/palette.js";
import { paint } from "../styles/index.js";

import type { Component } from "../controls/index.js";

export interface FleetStatusSectionOptions {
	readonly getNative?: () => boolean;
	readonly native?: boolean;
}

const BORDER_CHAR = "─";

export class FleetStatusSection implements Component {
	constructor(private readonly options: FleetStatusSectionOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		this.options.getNative?.();
		return [renderBorder(width, DIM_COLOR)];
	}
}

function renderBorder(width: number, color: string): string {
	if (width <= 0) return "";
	return paint(color, BORDER_CHAR.repeat(width), true);
}
