import type { EditorTheme } from "@sbluemin/fleet-tui";

type Formatter = (str: string) => string;

const ansi = {
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	gray: "\x1b[90m",
};
const RESET = "\x1b[0m";

export const fmt: {
	dim: Formatter;
	cyan: Formatter;
	green: Formatter;
	red: Formatter;
	gray: Formatter;
	reset: string;
} = {
	dim: (str) => `${ansi.dim}${str}${RESET}`,
	cyan: (str) => `${ansi.cyan}${str}${RESET}`,
	green: (str) => `${ansi.green}${str}${RESET}`,
	red: (str) => `${ansi.red}${str}${RESET}`,
	gray: (str) => `${ansi.gray}${str}${RESET}`,
	reset: RESET,
};

export const editorTheme: EditorTheme = {
	borderColor: (str) => fmt.dim(fmt.gray(str)),
	selectList: {
		selectedPrefix: (str) => fmt.cyan(str),
		selectedText: (str) => fmt.cyan(str),
		description: (str) => fmt.gray(str),
		scrollInfo: (str) => fmt.dim(str),
		noMatch: (str) => fmt.red(str),
	},
};
