import type { FleetPtyTheme } from "./theme.js";
import { fitLine, truncateToWidth, visibleWidth } from "../../primitives/cell-width.js";

export interface OverlayFrameOptions {
  readonly body: readonly OverlayFrameBodyLine[];
  readonly footer?: string;
  readonly theme: FleetPtyTheme;
  readonly title: string;
  readonly width: number;
}

export type OverlayFrameBodyLine = string | {
  readonly bg?: string;
  readonly text: string;
};

const BORDER = {
  bottomLeft: "╰",
  bottomRight: "╯",
  h: "─",
  topLeft: "╭",
  topRight: "╮",
  vertical: "│",
} as const;
const MIN_FRAME_WIDTH = 24;

export function createOverlayFrame(options: OverlayFrameOptions): string[] {
  const width = Math.max(MIN_FRAME_WIDTH, options.width);
  const innerWidth = Math.max(0, width - 4);
  const title = ` ${truncateToWidth(options.title, innerWidth)} `;
  const topFill = Math.max(0, width - 2 - visibleWidth(title));
  const leftFill = Math.floor(topFill / 2);
  const rightFill = topFill - leftFill;
  const top = options.theme.border(`${BORDER.topLeft}${BORDER.h.repeat(leftFill)}${title}${BORDER.h.repeat(rightFill)}${BORDER.topRight}`);
  const body = options.body.map((line) => frameBodyLine(line, innerWidth, options.theme));
  const footer = options.footer ? [frameBodyLine(options.theme.dim(options.footer), innerWidth, options.theme)] : [];
  const bottom = options.theme.border(`${BORDER.bottomLeft}${BORDER.h.repeat(Math.max(0, width - 2))}${BORDER.bottomRight}`);
  return [top, ...body, ...footer, bottom];
}

export function resolveOverlayFrameWidth(width: number): number {
  return Math.max(MIN_FRAME_WIDTH, width);
}

function frameBodyLine(line: OverlayFrameBodyLine, innerWidth: number, theme: FleetPtyTheme): string {
  const text = typeof line === "string" ? line : line.text;
  const bg = typeof line === "string" ? undefined : line.bg;
  const fitted = fitLine(text, innerWidth);
  const wrapped = bg ? `${bg}${fitted.replaceAll("\x1b[0m", `\x1b[0m${bg}`)}\x1b[0m` : fitted;
  return `${theme.border(BORDER.vertical)} ${wrapped} ${theme.border(BORDER.vertical)}`;
}
