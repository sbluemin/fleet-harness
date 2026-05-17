import { execFileSync } from "node:child_process";
import path from "node:path";

import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";
import { Container, Editor, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@sbluemin/fleet-tui";

export interface EditorSectionOptions {
	readonly rt: FleetCoreRuntimeContext;
	readonly sessionStartedAt: number;
}

interface BranchCacheEntry {
	readonly value: string | undefined;
	readonly expiresAt: number;
}

const ANSI_RESET = "\x1b[0m";
const BORDER_CHAR = "─";
const BRANCH_CACHE_TTL_MS = 5_000;
const PROMPT = "\x1b[38;2;200;200;200m>\x1b[0m";
const CWD_COLOR = "\x1b[38;2;115;218;202m";
const DIM_COLOR = "\x1b[38;5;244m";
const SEGMENT_SEPARATOR = " › ";
const STATUS_BORDER_RESERVED_WIDTH = 7;

const branchCache = new Map<string, BranchCacheEntry>();

export class EditorSection extends Container {
	public readonly editor: Editor;

	constructor(ui: TUI, theme: EditorTheme, options: EditorSectionOptions) {
		super();
		this.editor = new Editor(ui, theme);
		installFleetEditorRenderer(this.editor, options);
		this.addChild(this.editor);
	}
}

function installFleetEditorRenderer(editor: Editor, options: EditorSectionOptions): void {
	const originalRender = editor.render.bind(editor);
	editor.render = (width: number): string[] => {
		if (width < 10) return originalRender(width);

		const protocol = options.rt.admiral.protocols.getActiveProtocol();
		const borderColor = protocol.color ?? DIM_COLOR;
		const colorizeBorder = (text: string) => `${borderColor}${text}${ANSI_RESET}`;
		const contentWidth = Math.max(1, width - 3);
		const lines = originalRender(contentWidth);
		const bottomBorderIndex = findBottomBorderIndex(lines);
		const result: string[] = [];

		result.push(renderCenteredBorder(width, colorizeBorder, colorize(`⚓ ${protocol.shortLabel}`, borderColor)));

		if (bottomBorderIndex <= 1) {
			result.push(` ${PROMPT} ${" ".repeat(contentWidth)}`);
		} else {
			for (let index = 1; index < bottomBorderIndex; index++) {
				const prefix = index === 1 ? ` ${PROMPT} ` : "   ";
				result.push(`${prefix}${lines[index] ?? ""}`);
			}
		}

		result.push(renderStatusBorder(width, colorizeBorder, options.sessionStartedAt));

		for (let index = bottomBorderIndex + 1; index < lines.length; index++) {
			result.push(lines[index] ?? "");
		}

		return result;
	};
}

function findBottomBorderIndex(lines: string[]): number {
	for (let index = lines.length - 1; index >= 1; index--) {
		const stripped = stripAnsi(lines[index] ?? "");
		if (stripped.length > 0 && /^─{3,}/.test(stripped)) return index;
	}
	return Math.max(0, lines.length - 1);
}

function renderStatusBorder(width: number, colorizeBorder: (text: string) => string, sessionStartedAt: number): string {
	void sessionStartedAt;
	const segments = [colorize(getCompactCwd(process.cwd()), CWD_COLOR), getGitBranch(process.cwd())].filter(
		(segment): segment is string => Boolean(segment),
	);
	const label = fitStatusBorderLabel(` ${segments.join(`${DIM_COLOR}${SEGMENT_SEPARATOR}${ANSI_RESET}`)} `, width);
	return renderCenteredBorder(width, colorizeBorder, label);
}

function renderCenteredBorder(width: number, colorizeBorder: (text: string) => string, label: string): string {
	if (width <= 0) return "";
	const innerWidth = width - 2;
	const labelWidth = visibleWidth(label);
	const totalDash = innerWidth - labelWidth - 2;
	if (totalDash < 2) return renderSolidBorder(width, colorizeBorder);
	const leftDash = Math.floor(totalDash / 2);
	const rightDash = totalDash - leftDash;
	return ` ${colorizeBorder(BORDER_CHAR.repeat(leftDash))} ${label} ${colorizeBorder(BORDER_CHAR.repeat(rightDash))}`;
}

function renderSolidBorder(width: number, colorizeBorder: (text: string) => string): string {
	return ` ${colorizeBorder(BORDER_CHAR.repeat(Math.max(0, width - 2)))}`;
}

function fitStatusBorderLabel(label: string, width: number): string {
	const maxLabelWidth = Math.max(1, width - STATUS_BORDER_RESERVED_WIDTH);
	return visibleWidth(label) > maxLabelWidth ? truncateToWidth(label, maxLabelWidth) : label;
}

function getCompactCwd(cwd: string): string {
	const parsed = path.parse(cwd);
	const relative = path.relative(parsed.root, cwd);
	const parts = relative.split(path.sep).filter(Boolean);
	if (parts.length === 0) return parsed.root;
	return parts.slice(-2).join(path.sep);
}

function getGitBranch(cwd: string): string | undefined {
	const now = Date.now();
	const cached = branchCache.get(cwd);
	if (cached && cached.expiresAt > now) return cached.value;
	let value: string | undefined;
	try {
		const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
		value = branch ? colorize(branch, DIM_COLOR) : undefined;
	} catch {
		value = undefined;
	}
	branchCache.set(cwd, { value, expiresAt: now + BRANCH_CACHE_TTL_MS });
	return value;
}

function colorize(text: string, color: string): string {
	return `${color}${text}${ANSI_RESET}`;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
