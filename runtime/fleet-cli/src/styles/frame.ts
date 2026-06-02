import { centerLine, fitLine, visibleWidth } from "../tui/primitives/cell-width.js";

export interface FrameOptions {
  readonly body: readonly string[];
  readonly subtitle?: string;
  readonly title?: string;
  readonly width: number;
}

const MIN_FRAME_WIDTH = 8;

export function renderFrame(options: FrameOptions): string[] {
  const width = Math.max(MIN_FRAME_WIDTH, Math.floor(options.width));
  const innerWidth = Math.max(0, width - 4);
  const title = options.title === undefined ? "" : ` ${fitLine(options.title, innerWidth)} `;
  const top = makeBorder("┌", "┐", title, width);
  const subtitle = options.subtitle === undefined ? [] : [renderBodyLine(options.subtitle, innerWidth)];
  return [
    top,
    ...subtitle,
    ...options.body.map((line) => renderBodyLine(line, innerWidth)),
    makeBorder("└", "┘", "", width),
  ];
}

function makeBorder(left: string, right: string, label: string, width: number): string {
  const labelWidth = visibleWidth(label);
  const fillWidth = Math.max(0, width - 2 - labelWidth);
  return `${left}${label}${"─".repeat(fillWidth)}${right}`;
}

function renderBodyLine(line: string, innerWidth: number): string {
  return `│ ${centerLine(fitLine(line, innerWidth), innerWidth)} │`;
}
