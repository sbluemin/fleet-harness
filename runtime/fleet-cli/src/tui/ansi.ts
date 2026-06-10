export const ANSI_CLEAR_TO_END_OF_LINE = "\x1b[K";
export const ANSI_HIDE_CURSOR = "\x1b[?25l";
export const ANSI_SHOW_CURSOR = "\x1b[?25h";
export const ANSI_ENTER_ALT_SCREEN = "\x1b[?1049h";
export const ANSI_EXIT_ALT_SCREEN = "\x1b[?1049l";
export const ANSI_ENABLE_VT200_MOUSE = "\x1b[?1000h";
export const ANSI_DISABLE_VT200_MOUSE = "\x1b[?1000l";
export const ANSI_ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1002h";
export const ANSI_DISABLE_BUTTON_MOTION_MOUSE = "\x1b[?1002l";
export const ANSI_ENABLE_SGR_MOUSE = "\x1b[?1006h";
export const ANSI_DISABLE_SGR_MOUSE = "\x1b[?1006l";

export function moveCursorTo(row: number, column: number): string {
  return `\x1b[${row};${column}H`;
}

export function clearToEndOfLine(): string {
  return ANSI_CLEAR_TO_END_OF_LINE;
}

export function enterAltScreen(): string {
  return ANSI_ENTER_ALT_SCREEN;
}

export function exitAltScreen(): string {
  return ANSI_EXIT_ALT_SCREEN;
}

export function enableSgrMouse(): string {
  return `${ANSI_ENABLE_VT200_MOUSE}${ANSI_ENABLE_BUTTON_MOTION_MOUSE}${ANSI_ENABLE_SGR_MOUSE}`;
}

export function disableSgrMouse(): string {
  return `${ANSI_DISABLE_SGR_MOUSE}${ANSI_DISABLE_BUTTON_MOTION_MOUSE}${ANSI_DISABLE_VT200_MOUSE}`;
}
