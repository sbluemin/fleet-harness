import { ANSI_RESET } from "./ansi.js";

export const DIM_COLOR = "\x1b[38;5;244m";
export const DISABLED_COLOR = "\x1b[38;2;169;169;169m";

export function colorize(text: string, color: string | undefined): string {
  return color ? `${color}${text}${ANSI_RESET}` : text;
}

