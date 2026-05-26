export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_DIM = "\x1b[2m";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function paint(color: string, text: string, colorEnabled: boolean): string {
  if (!colorEnabled) {
    return text;
  }
  return `${color}${text}${ANSI_RESET}`;
}
