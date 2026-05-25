import { truncateToWidth, visibleWidth } from "../controls/index.js";

const ANSI_RESET = "\x1b[0m";
const FLEET_BANNER: readonly string[] = [
  "████ █    ████ ████ ███",
  "█    █    █    █     █ ",
  "███  █    ███  ███   █ ",
  "█    █    █    █     █ ",
  "█    ████ ████ ████  █ ",
];
const GRADIENT_COLORS: readonly string[] = [
  "\x1b[38;5;51m",
  "\x1b[38;5;45m",
  "\x1b[38;5;39m",
  "\x1b[38;5;33m",
  "\x1b[38;5;27m",
  "\x1b[38;5;21m",
];
const BANNER_VISIBLE_WIDTH = visibleWidth(FLEET_BANNER[0] ?? "");

export const FLEET_ACCENT = "\x1b[38;2;254;188;56m";
const FLEET_BANNER_MIN_WIDTH = BANNER_VISIBLE_WIDTH + 4;

export function buildFleetBanner(innerWidth: number): string[] {
  if (innerWidth < FLEET_BANNER_MIN_WIDTH) {
    return [];
  }
  return FLEET_BANNER.map((line) => centerText(gradientLine(line), innerWidth));
}

export function centerText(text: string, width: number): string {
  const textWidth = visibleWidth(text);
  if (textWidth >= width) {
    return truncateToWidth(text, width);
  }
  const leftPad = Math.floor((width - textWidth) / 2);
  const rightPad = width - textWidth - leftPad;
  return `${" ".repeat(leftPad)}${text}${" ".repeat(rightPad)}`;
}

function gradientLine(line: string): string {
  const step = Math.max(1, Math.floor(line.length / GRADIENT_COLORS.length));
  let result = "";
  let colorIndex = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (index > 0 && index % step === 0 && colorIndex < GRADIENT_COLORS.length - 1) {
      colorIndex += 1;
    }
    const char = line[index] ?? "";
    if (char === " ") {
      result += char;
    } else {
      result += `${GRADIENT_COLORS[colorIndex]}${char}${ANSI_RESET}`;
    }
  }
  return result;
}
