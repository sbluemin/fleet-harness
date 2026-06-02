import { stripControlSequences } from "../tui/primitives/cell-width.js";

export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_DIM = "\x1b[2m";

export function stripAnsi(text: string): string {
  // SGR 색상뿐 아니라 OSC/DCS 같은 터미널 제어 시퀀스까지 제거한다.
  return stripControlSequences(text);
}

export function paint(color: string, text: string, colorEnabled: boolean): string {
  if (!colorEnabled) {
    return text;
  }
  return `${color}${text}${ANSI_RESET}`;
}
