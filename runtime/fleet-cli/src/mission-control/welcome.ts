import { ANSI_RESET, ASCII_FLEET_BANNER, FLEET_ACCENT, GRADIENT_COLORS } from "../styles/index.js";

import { truncateToWidth, visibleWidth } from "../controls/index.js";

const FLEET_BANNER: readonly string[] = ASCII_FLEET_BANNER;
const BANNER_VISIBLE_WIDTH = visibleWidth(FLEET_BANNER[0] ?? "");

export { FLEET_ACCENT };
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
