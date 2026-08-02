import { stripControlSequences } from "../tui/primitives/cell-width.js";

export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_DIM = "\x1b[2m";

export function stripAnsi(text: string): string {
  // SGR 색상뿐 아니라 OSC/DCS 같은 터미널 제어 시퀀스까지 제거한다.
  return stripControlSequences(text);
}

export function paint(color: string, text: string, colorEnabled: boolean): string {
  if (!colorEnabled) {
    return text;
  }
  return `${color}${text}${ANSI_RESET}`;
}

export type RgbTuple = readonly [number, number, number];

export const FLEET_ACCENT = "\x1b[38;2;254;188;56m";
export const FLEET_OPTION = "\x1b[38;2;125;211;252m";
export const FLEET_COMMAND = "\x1b[38;2;94;234;212m";
export const DIM_COLOR = "\x1b[38;5;244m";
export const GRADIENT_RGBS: readonly RgbTuple[] = [
  [0, 255, 255],
  [0, 215, 255],
  [0, 175, 255],
  [0, 135, 255],
  [0, 95, 255],
  [0, 0, 255],
];
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

// 공유 FLEET ASCII 배너 — fleet --help와 mission-control welcome 양쪽에서 사용
// 모든 줄은 visible width 41로 통일 (T 글자 우측 패딩 3칸 포함). 줄별 너비가 다르면
// mission-control welcome.ts의 centerText가 줄을 개별 중앙 정렬할 때 좌측 padding이
// 어긋나 어그러져 보이므로 자산 자체에서 균일성을 보장한다.
export const ASCII_FLEET_BANNER: readonly string[] = [
  "███████╗██╗     ███████╗███████╗████████╗",
  "██╔════╝██║     ██╔════╝██╔════╝╚══██╔══╝",
  "█████╗  ██║     █████╗  █████╗     ██║   ",
  "██╔══╝  ██║     ██╔══╝  ██╔══╝     ██║   ",
  "██║     ███████╗███████╗███████╗   ██║   ",
  "╚═╝     ╚══════╝╚══════╝╚══════╝   ╚═╝   ",
];
