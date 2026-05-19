export const ANSI_RESET = "\x1b[0m";
export const ANSI_CLEAR_SCREEN = "\x1b[2J";
export const ANSI_CLEAR_TO_END = "\x1b[J";
export const ANSI_ERASE_LINE = "\x1b[2K";
export const ANSI_CURSOR_HOME = "\x1b[H";
export const ANSI_HIDE_CURSOR = "\x1b[?25l";
export const ANSI_SHOW_CURSOR = "\x1b[?25h";

export function moveCursorHome(): string {
  return ANSI_CURSOR_HOME;
}

export function moveCursorTo(row: number, column: number): string {
  return `\x1b[${row};${column}H`;
}

export function clearScreen(): string {
  return `${ANSI_CLEAR_SCREEN}${ANSI_CURSOR_HOME}`;
}

export function clearToEnd(): string {
  return ANSI_CLEAR_TO_END;
}

export function eraseLine(): string {
  return ANSI_ERASE_LINE;
}
