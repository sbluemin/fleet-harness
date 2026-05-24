import { CARRIER_COLORS } from "@dotobokuri/fleet-carriers";
import { createOverlayFrame, truncateToWidth, visibleWidth, type FleetPtyTheme, type PtyExitEvent } from "../controls/index.js";

import type { DedicatedCliId } from "../dedicated-cli/types.js";
import type { MissionControlCliOption, MissionControlStateKind } from "./types.js";

interface MissionControlRenderOptions {
  readonly cliOptions: readonly MissionControlCliOption[];
  readonly lastExit: PtyExitEvent | undefined;
  readonly selectedCliId: DedicatedCliId;
  readonly state: MissionControlStateKind;
}

type StatusTone = "dim" | "error" | "success" | "warning";

const ANSI_RESET = "\x1b[0m";
export const MISSION_CONTROL_THEME: FleetPtyTheme = {
  accent: (text) => style("\x1b[38;2;100;180;255m", text),
  bg: (name, text) => style(name === "selected" ? "\x1b[48;2;45;55;70m" : "\x1b[48;2;28;28;36m", text),
  bold: (text) => style("\x1b[1m", text),
  border: (text) => style("\x1b[38;2;100;180;255m", text),
  dim: (text) => style("\x1b[38;5;244m", text),
  error: (text) => style("\x1b[38;2;255;120;120m", text),
  fg: (name, text) => MISSION_CONTROL_THEME[name](text),
  muted: (text) => style("\x1b[38;2;160;150;180m", text),
  reset: (text) => `${text}${ANSI_RESET}`,
  success: (text) => style("\x1b[38;2;80;200;160m", text),
  warning: (text) => style("\x1b[38;2;255;200;100m", text),
};
const SELECTED_MARKER = "▸";
const IDLE_MARKER = " ";

export function renderMissionControl(width: number, options: MissionControlRenderOptions): string[] {
  const innerWidth = Math.max(0, Math.max(24, width) - 4);
  const body = [
    renderStatusLine(options.state, options.lastExit),
    "",
    ...options.cliOptions.map((entry, index) =>
      renderChoiceLine({
        entry,
        index,
        innerWidth,
        selected: entry.id === options.selectedCliId,
      })),
    "",
  ];

  return createOverlayFrame({
    body,
    footer: renderFooterHint(options.state),
    theme: MISSION_CONTROL_THEME,
    title: "Mission Control",
    width,
  });
}

function renderStatusLine(state: MissionControlStateKind, event: PtyExitEvent | undefined): string {
  const { text, tone } = getStatusText(state, event);
  return `  ${MISSION_CONTROL_THEME[tone]("●")} ${MISSION_CONTROL_THEME[tone](text)}`;
}

function renderChoiceLine(options: {
  readonly entry: MissionControlCliOption;
  readonly index: number;
  readonly innerWidth: number;
  readonly selected: boolean;
}): string | { bg?: string; text: string } {
  const marker = options.selected ? MISSION_CONTROL_THEME.accent(SELECTED_MARKER) : MISSION_CONTROL_THEME.dim(IDLE_MARKER);
  const number = MISSION_CONTROL_THEME.muted(`${options.index + 1}.`);
  const label = colorizeProvider(options.entry.id, options.entry.label);
  const prefix = `  ${marker} ${number} `;
  const labelWidth = Math.max(0, options.innerWidth - visibleWidth(prefix));
  const text = `${prefix}${truncateToWidth(label, labelWidth)}`;
  return {
    bg: options.selected ? "\x1b[48;2;45;55;70m" : undefined,
    text,
  };
}

function renderFooterHint(state: MissionControlStateKind): string {
  if (state === "launching") {
    return "Starting... please wait";
  }

  if (state === "ended" || state === "failed") {
    return "R relaunch  C choose CLI  X exit Fleet";
  }

  return "↑↓/j/k select  Enter start  1-9 quick pick  X exit Fleet";
}

function getStatusText(state: MissionControlStateKind, event: PtyExitEvent | undefined): { readonly text: string; readonly tone: StatusTone } {
  if (state === "launching") {
    return { text: "Starting selected CLI...", tone: "warning" };
  }

  if (state === "ended") {
    return { text: `Ended${formatExitEvent(event)}`, tone: "success" };
  }

  if (state === "failed") {
    return { text: `Failed${formatExitEvent(event)}`, tone: "error" };
  }

  return { text: "Choose a CLI for the upper pane.", tone: "dim" };
}

function formatExitEvent(event: PtyExitEvent | undefined): string {
  if (event === undefined) {
    return "";
  }

  const parts = [];
  if (event.exitCode !== undefined) {
    parts.push(`code ${event.exitCode}`);
  }
  if (event.signal !== undefined && event.signal !== 0) {
    parts.push(`signal ${event.signal}`);
  }
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function colorizeProvider(cliId: DedicatedCliId, text: string): string {
  const color = CARRIER_COLORS[cliId] ?? "";
  return color ? `${color}${text}${ANSI_RESET}` : text;
}

function style(code: string, text: string): string {
  return `${code}${text}${ANSI_RESET}`;
}
