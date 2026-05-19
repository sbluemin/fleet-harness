import { colorize } from "../core/color.js";

const DEFAULT_SEPARATOR = "─";

export function renderSeparator(width: number, color?: string): string {
  if (width <= 0) {
    return "";
  }

  return colorize(DEFAULT_SEPARATOR.repeat(width), color);
}

