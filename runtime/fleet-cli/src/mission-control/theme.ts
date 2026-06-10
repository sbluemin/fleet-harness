import { ANSI_RESET, FLEET_ACCENT, FLEET_COMMAND, paint as paintBranded } from "../styles/index.js";
import type { FleetPtyTheme } from "../controls/index.js";

export interface MissionControlTheme extends FleetPtyTheme {
  readonly section: (text: string) => string;
}

const SELECTED_BG = "\x1b[48;2;45;55;70m";
const DEFAULT_BG = "\x1b[48;2;28;28;36m";

export const MISSION_CONTROL_THEME: MissionControlTheme = {
  accent: (text) => paint(FLEET_ACCENT, text),
  bg: (name, text) => paintBackground(name === "selected" ? SELECTED_BG : DEFAULT_BG, text),
  bold: (text) => paint("\x1b[1m", text),
  border: (text) => paint("\x1b[38;5;244m", text),
  dim: (text) => paint("\x1b[38;5;244m", text),
  error: (text) => paint("\x1b[38;2;255;120;120m", text),
  fg: (name, text) => MISSION_CONTROL_THEME[name](text),
  muted: (text) => paint("\x1b[38;2;160;150;180m", text),
  reset: (text) => `${text}${ANSI_RESET}`,
  section: (text) => paint(FLEET_COMMAND, text),
  success: (text) => paint("\x1b[38;2;80;200;160m", text),
  warning: (text) => paint("\x1b[38;2;255;200;100m", text),
};

function paint(code: string, text: string): string {
  return paintBranded(code, text, true);
}

function paintBackground(code: string, text: string): string {
  return `${code}${text.replaceAll(ANSI_RESET, `${ANSI_RESET}${code}`)}${ANSI_RESET}`;
}
