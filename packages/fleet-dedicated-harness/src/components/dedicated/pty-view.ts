import type { Terminal as XtermTerminal } from "@xterm/headless";

import { createXterm, renderXtermViewport } from "../../pty/xterm-bridge.js";
import type { Component } from "../../tui/types.js";
import { truncateToWidth, visibleWidth } from "../../tui/primitives/text.js";

const MIN_ROWS = 0;
const MIN_COLUMNS = 1;

export class PtyView implements Component {
	private cols: number;
	private rows: number;
	private terminal: XtermTerminal;

	constructor(cols: number, rows: number) {
		this.cols = normalizeColumns(cols);
		this.rows = normalizeRows(rows);
		this.terminal = createTerminal(this.cols, this.rows);
	}

	public append(chunk: string, onFlushed?: () => void): void {
		if (chunk.length === 0 || this.rows === 0) {
			return;
		}

		this.terminal.write(chunk, onFlushed);
	}

	public resize(cols: number, rows: number): void {
		const nextCols = normalizeColumns(cols);
		const nextRows = normalizeRows(rows);
		if (nextCols === this.cols && nextRows === this.rows) {
			return;
		}

		this.cols = nextCols;
		this.rows = nextRows;
		this.terminal.resize(this.cols, this.rows);
	}

	public get maxRows(): number {
		return this.rows;
	}

	public render(width: number): string[] {
		const lines = getViewport(this.terminal);
		if (width <= 0) {
			return lines.map(() => "");
		}
		return lines.map((row) => (visibleWidth(row) > width ? truncateToWidth(row, width) : row));
	}

	public invalidate(): void {}
}

function normalizeColumns(cols: number): number {
	if (!Number.isFinite(cols)) {
		return MIN_COLUMNS;
	}
	return Math.max(MIN_COLUMNS, Math.floor(cols));
}

function normalizeRows(rows: number): number {
	if (!Number.isFinite(rows)) {
		return MIN_ROWS;
	}
	return Math.max(MIN_ROWS, Math.floor(rows));
}

function createTerminal(cols: number, rows: number): XtermTerminal {
	return createXterm(cols, rows);
}

function getViewport(terminal: XtermTerminal): string[] {
	return renderXtermViewport(terminal);
}
