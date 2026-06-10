import { ANSI_RESET, ASCII_FLEET_BANNER, FLEET_ACCENT, GRADIENT_RGBS, type RgbTuple } from "../styles/index.js";

import { truncateToWidth, visibleWidth } from "../controls/index.js";

export { FLEET_ACCENT };

const FLEET_BANNER: readonly string[] = ASCII_FLEET_BANNER;
const BANNER_VISIBLE_WIDTH = visibleWidth(FLEET_BANNER[0] ?? "");
const FLEET_BANNER_MIN_WIDTH = BANNER_VISIBLE_WIDTH + 4;

export function buildFleetBanner(innerWidth: number, phase = 0): string[] {
  if (innerWidth < FLEET_BANNER_MIN_WIDTH) {
    return [];
  }
  return FLEET_BANNER.map((line) => centerText(gradientLine(line, phase), innerWidth));
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

export function gradientLine(line: string, phase = 0): string {
  if (GRADIENT_RGBS.length === 0) {
    return line;
  }

  const gradientStep = Math.max(1, line.length / GRADIENT_RGBS.length);
  let result = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === " ") {
      result += char;
    } else {
      result += `${toRgbAnsi(interpolateGradient((index / gradientStep) - phase))}${char}${ANSI_RESET}`;
    }
  }
  return result;
}

function interpolateGradient(position: number): RgbTuple {
  const wrappedPosition = positiveModulo(position, GRADIENT_RGBS.length);
  const fromIndex = Math.floor(wrappedPosition);
  const toIndex = (fromIndex + 1) % GRADIENT_RGBS.length;
  const ratio = wrappedPosition - fromIndex;
  return lerpRgb(GRADIENT_RGBS[fromIndex] ?? GRADIENT_RGBS[0] ?? [0, 255, 255], GRADIENT_RGBS[toIndex] ?? GRADIENT_RGBS[0] ?? [0, 255, 255], ratio);
}

function lerpRgb(from: RgbTuple, to: RgbTuple, ratio: number): RgbTuple {
  return [
    lerpChannel(from[0], to[0], ratio),
    lerpChannel(from[1], to[1], ratio),
    lerpChannel(from[2], to[2], ratio),
  ];
}

function lerpChannel(from: number, to: number, ratio: number): number {
  return Math.round(from + ((to - from) * ratio));
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function toRgbAnsi([red, green, blue]: RgbTuple): string {
  return `\x1b[38;2;${red};${green};${blue}m`;
}
