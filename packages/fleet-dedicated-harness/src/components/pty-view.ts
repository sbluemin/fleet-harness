import type { Component } from "@sbluemin/fleet-tui";
import { truncateToWidth, visibleWidth } from "@sbluemin/fleet-tui";
import xterm from "@xterm/headless";
import type { IBufferCell, Terminal as XtermTerminal } from "@xterm/headless";

type ColorMode = "default" | "palette" | "rgb";

type CellStyle = {
	readonly bg: number;
	readonly bgMode: ColorMode;
	readonly blink: boolean;
	readonly bold: boolean;
	readonly dim: boolean;
	readonly fg: number;
	readonly fgMode: ColorMode;
	readonly inverse: boolean;
	readonly italic: boolean;
	readonly overline: boolean;
	readonly strikethrough: boolean;
	readonly underline: boolean;
};

const MIN_ROWS = 0;
const MIN_COLUMNS = 1;
const ANSI_RESET = "\x1b[0m";
const DEFAULT_STYLE: CellStyle = {
	bg: 0,
	bgMode: "default",
	blink: false,
	bold: false,
	dim: false,
	fg: 0,
	fgMode: "default",
	inverse: false,
	italic: false,
	overline: false,
	strikethrough: false,
	underline: false,
};

const XtermTerminalCtor = xterm.Terminal;

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
	return new XtermTerminalCtor({
		allowProposedApi: true,
		cols,
		disableStdin: true,
		rows,
		scrollback: 1_000,
	});
}

function getViewport(terminal: XtermTerminal): string[] {
	const buffer = terminal.buffer.active;
	const lines: string[] = [];

	for (let index = 0; index < terminal.rows; index += 1) {
		const line = buffer.getLine(buffer.viewportY + index);
		lines.push(line ? renderLine(line, terminal.cols) : "");
	}

	return lines;
}

function renderLine(line: NonNullable<ReturnType<XtermTerminal["buffer"]["active"]["getLine"]>>, cols: number): string {
	let rendered = "";
	let activeStyle = DEFAULT_STYLE;
	let hasStyle = false;

	for (let index = 0; index < cols; index += 1) {
		const cell = line.getCell(index);
		if (!cell || cell.getWidth() === 0) {
			continue;
		}

		const nextStyle = getCellStyle(cell);
		if (!sameStyle(activeStyle, nextStyle)) {
			rendered += toSgr(nextStyle);
			activeStyle = nextStyle;
			hasStyle = !sameStyle(nextStyle, DEFAULT_STYLE);
		}

		rendered += cell.getChars() || " ";
	}

	if (hasStyle) {
		rendered += ANSI_RESET;
	}

	return rendered;
}

function getCellStyle(cell: IBufferCell): CellStyle {
	return {
		bg: cell.getBgColor(),
		bgMode: getColorMode(cell, "bg"),
		blink: Boolean(cell.isBlink()),
		bold: Boolean(cell.isBold()),
		dim: Boolean(cell.isDim()),
		fg: cell.getFgColor(),
		fgMode: getColorMode(cell, "fg"),
		inverse: Boolean(cell.isInverse()),
		italic: Boolean(cell.isItalic()),
		overline: Boolean(cell.isOverline()),
		strikethrough: Boolean(cell.isStrikethrough()),
		underline: Boolean(cell.isUnderline()),
	};
}

function getColorMode(cell: IBufferCell, target: "fg" | "bg"): ColorMode {
	if (target === "fg") {
		if (cell.isFgRGB()) return "rgb";
		if (cell.isFgPalette()) return "palette";
		return "default";
	}

	if (cell.isBgRGB()) return "rgb";
	if (cell.isBgPalette()) return "palette";
	return "default";
}

function sameStyle(left: CellStyle, right: CellStyle): boolean {
	return (
		left.bg === right.bg &&
		left.bgMode === right.bgMode &&
		left.blink === right.blink &&
		left.bold === right.bold &&
		left.dim === right.dim &&
		left.fg === right.fg &&
		left.fgMode === right.fgMode &&
		left.inverse === right.inverse &&
		left.italic === right.italic &&
		left.overline === right.overline &&
		left.strikethrough === right.strikethrough &&
		left.underline === right.underline
	);
}

function toSgr(style: CellStyle): string {
	const codes = ["0"];
	if (style.bold) codes.push("1");
	if (style.dim) codes.push("2");
	if (style.italic) codes.push("3");
	if (style.underline) codes.push("4");
	if (style.blink) codes.push("5");
	if (style.inverse) codes.push("7");
	if (style.strikethrough) codes.push("9");
	if (style.overline) codes.push("53");
	codes.push(...colorCodes("fg", style.fgMode, style.fg));
	codes.push(...colorCodes("bg", style.bgMode, style.bg));
	return `\x1b[${codes.join(";")}m`;
}

function colorCodes(target: "fg" | "bg", mode: ColorMode, color: number): string[] {
	if (mode === "default") {
		return [];
	}

	const base = target === "fg" ? "38" : "48";
	if (mode === "palette") {
		return [base, "5", String(color)];
	}

	const red = (color >> 16) & 0xff;
	const green = (color >> 8) & 0xff;
	const blue = color & 0xff;
	return [base, "2", String(red), String(green), String(blue)];
}
