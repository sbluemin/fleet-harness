export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_DIM = "\x1b[2m";

const CONTROL_SEQUENCE_PATTERN = /(?:\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*(?:\x1b\\|$)|[_^X][^\x1b]*(?:\x1b\\|$)|[@-_])|[\x90\x98\x9d\x9e\x9f][^\x9c]*(?:\x9c|$)|\x9b[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(text: string): string {
  // SGR 색상뿐 아니라 OSC/DCS 같은 터미널 제어 시퀀스까지 제거한다.
  return text.replace(CONTROL_SEQUENCE_PATTERN, "");
}

export function paint(color: string, text: string, colorEnabled: boolean): string {
  if (!colorEnabled) {
    return text;
  }
  return `${color}${text}${ANSI_RESET}`;
}

export const FLEET_ACCENT = "\x1b[38;2;254;188;56m";
export const FLEET_OPTION = "\x1b[38;2;125;211;252m";
export const FLEET_COMMAND = "\x1b[38;2;94;234;212m";
export const GRADIENT_COLORS: readonly string[] = [
  "\x1b[38;2;0;255;255m",
  "\x1b[38;2;0;215;255m",
  "\x1b[38;2;0;175;255m",
  "\x1b[38;2;0;135;255m",
  "\x1b[38;2;0;95;255m",
  "\x1b[38;2;0;0;255m",
];

export interface ResolveColorEnabledOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
}

export function resolveColorEnabled(options: ResolveColorEnabledOptions = {}): boolean {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? process.stdout.isTTY;
  return isTTY === true && env.NO_COLOR === undefined;
}

export function section(text: string, colorEnabled: boolean): string {
  return paint(`${ANSI_BOLD}${FLEET_ACCENT}`, text, colorEnabled);
}

export function command(text: string, colorEnabled: boolean): string {
  return paint(FLEET_COMMAND, text, colorEnabled);
}

export function option(text: string, colorEnabled: boolean): string {
  return paint(FLEET_OPTION, text, colorEnabled);
}

export function dim(text: string, colorEnabled: boolean): string {
  return paint(ANSI_DIM, text, colorEnabled);
}

export const ASCII_FLEET_BANNER: readonly string[] = [
  "███████╗██╗     ███████╗███████╗████████╗",
  "██╔════╝██║     ██╔════╝██╔════╝╚══██╔══╝",
  "█████╗  ██║     █████╗  █████╗     ██║   ",
  "██╔══╝  ██║     ██╔══╝  ██╔══╝     ██║   ",
  "██║     ███████╗███████╗███████╗   ██║   ",
  "╚═╝     ╚══════╝╚══════╝╚══════╝   ╚═╝   ",
];
