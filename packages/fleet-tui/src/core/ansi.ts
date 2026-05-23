export const ANSI_RESET = "\x1b[0m";
export const ANSI_CLEAR_SCREEN = "\x1b[2J";
export const ANSI_CLEAR_TO_END = "\x1b[J";
export const ANSI_CLEAR_TO_END_OF_LINE = "\x1b[K";
export const ANSI_ERASE_LINE = "\x1b[2K";
export const ANSI_CURSOR_HOME = "\x1b[H";
export const ANSI_HIDE_CURSOR = "\x1b[?25l";
export const ANSI_SHOW_CURSOR = "\x1b[?25h";
export const ANSI_ENTER_ALT_SCREEN = "\x1b[?1049h";
export const ANSI_EXIT_ALT_SCREEN = "\x1b[?1049l";
export const ANSI_ENABLE_VT200_MOUSE = "\x1b[?1000h";
export const ANSI_DISABLE_VT200_MOUSE = "\x1b[?1000l";
export const ANSI_ENABLE_SGR_MOUSE = "\x1b[?1006h";
export const ANSI_DISABLE_SGR_MOUSE = "\x1b[?1006l";

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

export function clearToEndOfLine(): string {
  return ANSI_CLEAR_TO_END_OF_LINE;
}

export function eraseLine(): string {
  return ANSI_ERASE_LINE;
}

export function enterAltScreen(): string {
  return ANSI_ENTER_ALT_SCREEN;
}

export function exitAltScreen(): string {
  return ANSI_EXIT_ALT_SCREEN;
}

export function enableSgrMouse(): string {
  return `${ANSI_ENABLE_VT200_MOUSE}${ANSI_ENABLE_SGR_MOUSE}`;
}

export function disableSgrMouse(): string {
  return `${ANSI_DISABLE_SGR_MOUSE}${ANSI_DISABLE_VT200_MOUSE}`;
}
