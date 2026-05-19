import { ANSI_RESET } from "../../core/ansi.js";

export interface FleetPtyTheme {
  readonly accent: (text: string) => string;
  readonly bg: (name: FleetPtyBgColor, text: string) => string;
  readonly bold: (text: string) => string;
  readonly border: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly error: (text: string) => string;
  readonly fg: (name: FleetPtyFgColor, text: string) => string;
  readonly muted: (text: string) => string;
  readonly success: (text: string) => string;
  readonly warning: (text: string) => string;
}

export type FleetPtyFgColor = "accent" | "border" | "dim" | "error" | "muted" | "success" | "warning";

export type FleetPtyBgColor = "panel" | "selected";

const FG: Record<FleetPtyFgColor, string> = {
  accent: "\x1b[38;2;100;180;255m",
  border: "\x1b[38;2;100;180;255m",
  dim: "\x1b[38;5;244m",
  error: "\x1b[38;2;255;120;120m",
  muted: "\x1b[38;2;160;150;180m",
  success: "\x1b[38;2;80;200;160m",
  warning: "\x1b[38;2;255;200;100m",
};
const BG: Record<FleetPtyBgColor, string> = {
  panel: "\x1b[48;2;28;28;36m",
  selected: "\x1b[48;2;45;55;70m",
};

export function createFleetPtyTheme(): FleetPtyTheme {
  return {
    accent: (text) => style(FG.accent, text),
    bg: (name, text) => style(BG[name], text),
    bold: (text) => style("\x1b[1m", text),
    border: (text) => style(FG.border, text),
    dim: (text) => style(FG.dim, text),
    error: (text) => style(FG.error, text),
    fg: (name, text) => style(FG[name], text),
    muted: (text) => style(FG.muted, text),
    success: (text) => style(FG.success, text),
    warning: (text) => style(FG.warning, text),
  };
}

function style(code: string, text: string): string {
  return `${code}${text}${ANSI_RESET}`;
}
