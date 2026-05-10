/**
 * core-welcome — 웰컴 화면 확장
 *
 * 세션 시작 시 웰컴 헤더를 표시하고,
 * 에이전트 활동 시작 또는 외부 bridge 호출 시 자동으로 해제한다.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@sbluemin/fleet-coding-agent";
import type { Component } from "@sbluemin/fleet-tui";
import { visibleWidth } from "@sbluemin/fleet-tui";

export interface WelcomeBridge {
	dismiss: () => void;
}

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LoadedCounts {
	contextFiles: number;
	extensions: number;
	skills: number;
	promptTemplates: number;
}

interface WelcomeData {
	modelName: string;
	providerName: string;
	recentSessions: RecentSession[];
	loadedCounts: LoadedCounts;
}

interface WelcomeState {
	dismissFn: (() => void) | null;
	headerActive: boolean;
	shouldDismiss: boolean;
	currentCtx: any | null;
}

const ANSI_RESET = "\x1b[0m";

const WELCOME_COLORS: Record<string, string> = {
	sep: "\x1b[38;5;244m",
	model: "\x1b[38;2;215;135;175m",
	path: "\x1b[38;2;0;175;175m",
	gitClean: "\x1b[38;2;95;175;95m",
	accent: "\x1b[38;2;254;188;56m",
};

const ansi = {
	reset: ANSI_RESET,
};

const FLEET_BANNER = [
	"████ █    ████ ████ ███",
	"█    █    █    █     █ ",
	"███  █    ███  ███   █ ",
	"█    █    █    █     █ ",
	"█    ████ ████ ████  █ ",
];

const GRADIENT_COLORS = [
	"\x1b[38;5;51m",
	"\x1b[38;5;45m",
	"\x1b[38;5;39m",
	"\x1b[38;5;33m",
	"\x1b[38;5;27m",
	"\x1b[38;5;21m",
];

const MIN_LAYOUT_WIDTH = 44;
const MIN_WELCOME_WIDTH = 76;
const MAX_WELCOME_WIDTH = 96;

let welcomeBridge: WelcomeBridge | null = null;

export class WelcomeHeader implements Component {
	private data: WelcomeData;

	constructor(
		modelName: string,
		providerName: string,
		recentSessions: RecentSession[] = [],
		loadedCounts: LoadedCounts = { contextFiles: 0, extensions: 0, skills: 0, promptTemplates: 0 },
	) {
		this.data = { modelName, providerName, recentSessions, loadedCounts };
	}

	invalidate(): void {}

	render(termWidth: number): string[] {
		if (termWidth < MIN_LAYOUT_WIDTH) {
			return [];
		}

		const boxWidth = getWelcomeBoxWidth(termWidth);
		const hChar = "─";
		const leftCol = 26;
		const rightCol = Math.max(1, boxWidth - leftCol - 3);
		const bottomLine = dim(hChar.repeat(leftCol)) + dim("┴") + dim(hChar.repeat(rightCol));
		const lines = renderWelcomeBox(this.data, termWidth, bottomLine);
		if (lines.length > 0) {
			lines.push("");
		}
		return lines;
	}
}

export function getWelcomeBridge(): WelcomeBridge | null {
	return welcomeBridge;
}

export function setWelcomeBridge(bridge: WelcomeBridge | null): void {
	welcomeBridge = bridge;
}

export function discoverLoadedCounts(): LoadedCounts {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "";
	const cwd = process.cwd();

	let contextFiles = 0;
	let extensions = 0;
	let skills = 0;
	let promptTemplates = 0;

	const agentsMdPaths = [
		join(homeDir, ".fleet", "agent", "AGENTS.md"),
		join(homeDir, ".claude", "AGENTS.md"),
		join(cwd, "AGENTS.md"),
		join(cwd, ".fleet", "AGENTS.md"),
		join(cwd, ".claude", "AGENTS.md"),
	];

	for (const path of agentsMdPaths) {
		if (existsSync(path)) contextFiles++;
	}

	const extensionDirs = [
		join(homeDir, ".fleet", "agent", "extensions"),
		join(cwd, "extensions"),
		join(cwd, ".fleet", "extensions"),
	];
	const countedExtensions = new Set<string>();

	for (const dir of extensionDirs) {
		if (!existsSync(dir)) continue;
		try {
			const entries = readdirSync(dir);
			for (const entry of entries) {
				const entryPath = join(dir, entry);
				const stats = statSync(entryPath);
				if (stats.isDirectory()) {
					if (existsSync(join(entryPath, "index.ts")) || existsSync(join(entryPath, "package.json"))) {
						if (!countedExtensions.has(entry)) {
							countedExtensions.add(entry);
							extensions++;
						}
					}
				} else if (entry.endsWith(".ts") && !entry.startsWith(".")) {
					const name = basename(entry, ".ts");
					if (!countedExtensions.has(name)) {
						countedExtensions.add(name);
						extensions++;
					}
				}
			}
		} catch {}
	}

	const skillDirs = [
		join(homeDir, ".fleet", "agent", "skills"),
		join(cwd, ".fleet", "skills"),
		join(cwd, "skills"),
	];
	const countedSkills = new Set<string>();

	for (const dir of skillDirs) {
		if (!existsSync(dir)) continue;
		try {
			const entries = readdirSync(dir);
			for (const entry of entries) {
				const entryPath = join(dir, entry);
				try {
					if (statSync(entryPath).isDirectory() && existsSync(join(entryPath, "SKILL.md"))) {
						if (!countedSkills.has(entry)) {
							countedSkills.add(entry);
							skills++;
						}
					}
				} catch {}
			}
		} catch {}
	}

	const templateDirs = [
		join(homeDir, ".fleet", "agent", "commands"),
		join(homeDir, ".claude", "commands"),
		join(cwd, ".fleet", "commands"),
		join(cwd, ".claude", "commands"),
	];
	const countedTemplates = new Set<string>();

	function countTemplatesInDir(dir: string): void {
		if (!existsSync(dir)) return;
		try {
			const entries = readdirSync(dir);
			for (const entry of entries) {
				const entryPath = join(dir, entry);
				try {
					const stats = statSync(entryPath);
					if (stats.isDirectory()) {
						countTemplatesInDir(entryPath);
					} else if (entry.endsWith(".md")) {
						const name = basename(entry, ".md");
						if (!countedTemplates.has(name)) {
							countedTemplates.add(name);
							promptTemplates++;
						}
					}
				} catch {}
			}
		} catch {}
	}

	for (const dir of templateDirs) {
		countTemplatesInDir(dir);
	}

	return { contextFiles, extensions, skills, promptTemplates };
}

export function getRecentSessions(maxCount: number = 3): RecentSession[] {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "";
	const sessionsDirs = [join(homeDir, ".fleet", "agent", "sessions"), join(homeDir, ".fleet", "sessions")];
	const sessions: { name: string; mtime: number }[] = [];

	function scanDir(dir: string): void {
		if (!existsSync(dir)) return;
		try {
			const entries = readdirSync(dir);
			for (const entry of entries) {
				const entryPath = join(dir, entry);
				try {
					const stats = statSync(entryPath);
					if (stats.isDirectory()) {
						scanDir(entryPath);
					} else if (entry.endsWith(".jsonl")) {
						const parentName = basename(dir);
						let projectName = parentName;
						if (parentName.startsWith("--")) {
							const parts = parentName.split("-").filter((part) => part);
							projectName = parts[parts.length - 1] || parentName;
						}
						sessions.push({ name: projectName, mtime: stats.mtimeMs });
					}
				} catch {}
			}
		} catch {}
	}

	for (const sessionsDir of sessionsDirs) {
		scanDir(sessionsDir);
	}

	if (sessions.length === 0) return [];
	sessions.sort((left, right) => right.mtime - left.mtime);

	const seen = new Set<string>();
	const uniqueSessions: typeof sessions = [];
	for (const session of sessions) {
		if (!seen.has(session.name)) {
			seen.add(session.name);
			uniqueSessions.push(session);
		}
	}

	const now = Date.now();
	return uniqueSessions.slice(0, maxCount).map((session) => ({
		name: session.name.length > 20 ? `${session.name.slice(0, 17)}…` : session.name,
		timeAgo: formatTimeAgo(now - session.mtime),
	}));
}

export default function registerWelcome(pi: ExtensionAPI): void {
	const state: WelcomeState = {
		dismissFn: null,
		headerActive: false,
		shouldDismiss: false,
		currentCtx: null,
	};

	setWelcomeBridge({
		dismiss: () => dismissWelcome(state.currentCtx, state),
	} satisfies WelcomeBridge);

	pi.on("session_start", async (event, ctx) => {
		state.currentCtx = ctx;

		if (event.reason === "resume" || event.reason === "new") {
			dismissWelcome(ctx, state);
			return;
		}

		state.dismissFn = null;
		state.headerActive = false;
		state.shouldDismiss = false;

		if (!ctx.hasUI) return;
		setupWelcomeHeader(ctx, state);
	});

	pi.on("session_shutdown", async () => {
		state.dismissFn = null;
		state.headerActive = false;
		state.shouldDismiss = false;
		state.currentCtx = null;
	});

	pi.on("agent_start", async (_event, ctx) => {
		dismissWelcome(ctx, state);
	});

	pi.on("tool_call", async (_event, ctx) => {
		dismissWelcome(ctx, state);
	});
}

function fgOnly(color: string, text: string): string {
	const code = WELCOME_COLORS[color];
	return code ? `${code}${text}` : text;
}

function getFgAnsiCode(color: string): string {
	return WELCOME_COLORS[color] ?? "";
}

function isStaleExtensionContextError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	if (message.includes("agent listener invoked outside active run")) return true;
	const mentionsExtensionCtx =
		message.includes("extensioncontext") ||
		message.includes("extension ctx") ||
		message.includes("extension context");
	const mentionsStaleSession =
		message.includes("stale") ||
		message.includes("session") ||
		message.includes("replacement") ||
		message.includes("reload");
	return mentionsExtensionCtx && mentionsStaleSession;
}

function dismissWelcome(ctx: any, state: WelcomeState): void {
	if (state.dismissFn) {
		try {
			state.dismissFn();
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
		state.dismissFn = null;
	} else {
		state.shouldDismiss = true;
	}
	if (state.headerActive) {
		state.headerActive = false;
		clearWelcomeHeader(ctx);
	}
}

function clearWelcomeHeader(ctx: any): void {
	if (!ctx?.ui?.setHeader) return;
	try {
		ctx.ui.setHeader(undefined);
	} catch (error) {
		if (!isStaleExtensionContextError(error)) throw error;
	}
}

function setupWelcomeHeader(ctx: any, state: WelcomeState): void {
	const modelName = ctx.model?.name || ctx.model?.id || "No model";
	const providerName = ctx.model?.provider || "Unknown";
	const loadedCounts = discoverLoadedCounts();
	const recentSessions = getRecentSessions(3);
	const header = new WelcomeHeader(modelName, providerName, recentSessions, loadedCounts);
	state.headerActive = true;

	ctx.ui.setHeader(() => {
		return {
			render(width: number): string[] {
				return header.render(width);
			},
			invalidate() {
				header.invalidate();
			},
		};
	});
}

function bold(text: string): string {
	return `\x1b[1m${text}\x1b[22m`;
}

function dim(text: string): string {
	return getFgAnsiCode("sep") + text + ansi.reset;
}

function checkmark(): string {
	return fgOnly("gitClean", "✓");
}

function gradientLine(line: string): string {
	const reset = ansi.reset;
	let result = "";
	let colorIdx = 0;
	const step = Math.max(1, Math.floor(line.length / GRADIENT_COLORS.length));

	for (let index = 0; index < line.length; index++) {
		if (index > 0 && index % step === 0 && colorIdx < GRADIENT_COLORS.length - 1) colorIdx++;
		const char = line[index];
		if (char !== " ") {
			result += GRADIENT_COLORS[colorIdx] + char + reset;
		} else {
			result += char;
		}
	}
	return result;
}

function centerText(text: string, width: number): string {
	const visLen = visibleWidth(text);
	if (visLen > width) return truncateToWidth(text, width);
	if (visLen === width) return text;
	const leftPad = Math.floor((width - visLen) / 2);
	const rightPad = width - visLen - leftPad;
	return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

function fitToWidth(str: string, width: number): string {
	const visLen = visibleWidth(str);
	if (visLen > width) return truncateToWidth(str, width);
	return str + " ".repeat(width - visLen);
}

function truncateToWidth(str: string, width: number): string {
	const ellipsis = "…";
	const maxWidth = Math.max(0, width - 1);
	let truncated = "";
	let currentWidth = 0;
	let inEscape = false;

	for (const char of str) {
		if (char === "\x1b") inEscape = true;
		if (inEscape) {
			truncated += char;
			if (char === "m") inEscape = false;
		} else if (currentWidth < maxWidth) {
			truncated += char;
			currentWidth++;
		}
	}

	if (visibleWidth(str) > width) return truncated + ellipsis;
	return truncated;
}

function getWelcomeBoxWidth(termWidth: number): number {
	return Math.min(termWidth, Math.max(MIN_WELCOME_WIDTH, Math.min(termWidth - 2, MAX_WELCOME_WIDTH)));
}

function applyHorizontalPadding(lines: string[], termWidth: number, boxWidth: number): string[] {
	const hPad = Math.max(0, Math.floor((termWidth - boxWidth) / 2));
	if (hPad === 0) return lines;
	const pad = " ".repeat(hPad);
	return lines.map((line) => pad + line);
}

function buildFleetBanner(data: WelcomeData, colWidth: number): string[] {
	const bannerColored = FLEET_BANNER.map((line) => gradientLine(line));
	return [
		"",
		...bannerColored.map((line) => centerText(line, colWidth)),
		"",
		centerText(fgOnly("model", data.modelName), colWidth),
		centerText(dim(data.providerName), colWidth),
		"",
	];
}

function buildFleetInfo(data: WelcomeData, colWidth: number): string[] {
	const hChar = "─";
	const separator = ` ${dim(hChar.repeat(colWidth - 2))}`;
	const sessionLines: string[] = [];

	if (data.recentSessions.length === 0) {
		sessionLines.push(` ${dim("No recent sessions")}`);
	} else {
		for (const session of data.recentSessions.slice(0, 3)) {
			sessionLines.push(` ${dim("▸ ")}${fgOnly("path", session.name)}${dim(` ${session.timeAgo}`)}`);
		}
	}

	const countLines: string[] = [];
	const { contextFiles, extensions, skills, promptTemplates } = data.loadedCounts;
	if (contextFiles > 0 || extensions > 0 || skills > 0 || promptTemplates > 0) {
		if (contextFiles > 0) {
			countLines.push(` ${checkmark()} ${fgOnly("gitClean", `${contextFiles}`)} context file${contextFiles !== 1 ? "s" : ""}`);
		}
		if (extensions > 0) {
			countLines.push(` ${checkmark()} ${fgOnly("gitClean", `${extensions}`)} extension${extensions !== 1 ? "s" : ""}`);
		}
		if (skills > 0) {
			countLines.push(` ${checkmark()} ${fgOnly("gitClean", `${skills}`)} skill${skills !== 1 ? "s" : ""}`);
		}
		if (promptTemplates > 0) {
			countLines.push(
				` ${checkmark()} ${fgOnly("gitClean", `${promptTemplates}`)} prompt template${promptTemplates !== 1 ? "s" : ""}`,
			);
		}
	} else {
		countLines.push(` ${dim("Nothing loaded")}`);
	}

	return [
		` ${bold(fgOnly("accent", "Shortcuts"))}`,
		` ${dim("/")} commands  ${dim("·")} ${dim("!")} shell`,
		` ${dim("Alt+.")} keybinds`,
		` ${dim("Alt+H/L")} carriers`,
		separator,
		` ${bold(fgOnly("accent", "Loaded"))}`,
		...countLines,
		separator,
		` ${bold(fgOnly("accent", "Recent"))}`,
		...sessionLines,
		"",
	];
}

function renderWelcomeBox(data: WelcomeData, termWidth: number, bottomLine: string): string[] {
	if (termWidth < MIN_LAYOUT_WIDTH) {
		return [];
	}

	const boxWidth = getWelcomeBoxWidth(termWidth);
	const leftCol = 26;
	const rightCol = Math.max(1, boxWidth - leftCol - 3);
	const hChar = "─";
	const v = dim("│");
	const tl = dim("╭");
	const tr = dim("╮");
	const bl = dim("╰");
	const br = dim("╯");
	const leftLines = buildFleetBanner(data, leftCol);
	const rightLines = buildFleetInfo(data, rightCol);
	const lines: string[] = [];

	const title = " Fleet ";
	const titlePrefix = dim(hChar.repeat(3));
	const titleStyled = titlePrefix + fgOnly("accent", title);
	const titleVisLen = 3 + visibleWidth(title);
	const afterTitle = boxWidth - 2 - titleVisLen;
	const afterTitleText = afterTitle > 0 ? dim(hChar.repeat(afterTitle)) : "";
	lines.push(tl + titleStyled + afterTitleText + tr);

	const maxRows = Math.max(leftLines.length, rightLines.length);
	for (let index = 0; index < maxRows; index++) {
		const left = fitToWidth(leftLines[index] ?? "", leftCol);
		const right = fitToWidth(rightLines[index] ?? "", rightCol);
		lines.push(v + left + v + right + v);
	}

	lines.push(bl + bottomLine + br);
	return applyHorizontalPadding(lines, termWidth, boxWidth);
}

function formatTimeAgo(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (minutes > 0) return `${minutes}m ago`;
	return "just now";
}
