import { CARRIER_COLORS } from "@dotobokuri/fleet-carriers";
import { ANSI_RESET, paint as paintBranded } from "@dotobokuri/fleet-tui/style";
import { truncateToWidth, visibleWidth, type FleetPtyTheme, type PtyExitEvent } from "../controls/index.js";

import type { AgentCliId } from "../agent-cli/types.js";
import type { FleetCliRelease, MissionControlCounts } from "./loaded-counts.js";
import type { MissionControlCliOption, MissionControlFleetMenuState, MissionControlOptionDrawerState, MissionControlOverlay, MissionControlStateKind } from "./types.js";
import { buildFleetBanner, centerText, FLEET_ACCENT } from "./welcome.js";

interface MissionControlRenderOptions {
  readonly cliOptions: readonly MissionControlCliOption[];
  readonly editingModel?: string;
  readonly fleetMenu?: MissionControlFleetMenuState;
  readonly lastExit: PtyExitEvent | undefined;
  readonly loadedCounts: MissionControlCounts | undefined;
  readonly panelLines?: readonly string[];
  readonly release: FleetCliRelease | undefined;
  readonly selectedCliId: AgentCliId;
  readonly overlay?: MissionControlOverlay;
  readonly optionDrawer?: MissionControlOptionDrawerState;
  readonly state: MissionControlStateKind;
}

type StatusTone = "dim" | "error" | "success" | "warning";

const SELECTED_MARKER = "▸";
const IDLE_MARKER = " ";
const CHOICE_INDENT = 4;
const COUNT_SEPARATOR = "  ·  ";
const OPTION_DRAWER_LABEL_WIDTH = 13;
const OPTION_DRAWER_VALUE_WIDTH = 18;
const OPTION_DRAWER_SOURCE_WIDTH = 7;
const OPTION_DRAWER_HINT_WIDTH = 8;
const FLEET_MENU_ITEMS: readonly string[] = [
  "Authentication",
  "Wiki Server",
  "Diagnostics",
  "About",
];

export const MISSION_CONTROL_THEME: FleetPtyTheme = {
  accent: (text) => paint(FLEET_ACCENT, text),
  bg: (name, text) => paint(name === "selected" ? "\x1b[48;2;45;55;70m" : "\x1b[48;2;28;28;36m", text),
  bold: (text) => paint("\x1b[1m", text),
  border: (text) => paint("\x1b[38;5;244m", text),
  dim: (text) => paint("\x1b[38;5;244m", text),
  error: (text) => paint("\x1b[38;2;255;120;120m", text),
  fg: (name, text) => MISSION_CONTROL_THEME[name](text),
  muted: (text) => paint("\x1b[38;2;160;150;180m", text),
  reset: (text) => `${text}${ANSI_RESET}`,
  success: (text) => paint("\x1b[38;2;80;200;160m", text),
  warning: (text) => paint("\x1b[38;2;255;200;100m", text),
};
const STYLE: Record<StatusTone | "accent" | "muted", (text: string) => string> = {
  accent: MISSION_CONTROL_THEME.accent,
  dim: MISSION_CONTROL_THEME.dim,
  error: MISSION_CONTROL_THEME.error,
  muted: MISSION_CONTROL_THEME.muted,
  success: MISSION_CONTROL_THEME.success,
  warning: MISSION_CONTROL_THEME.warning,
};

export function renderMissionControl(width: number, options: MissionControlRenderOptions): string[] {
  const innerWidth = Math.max(0, width);
  const banner = buildFleetBanner(innerWidth);
  const choiceWidth = computeChoiceWidth(options.cliOptions);
  const choiceLeftPad = Math.max(0, Math.floor((innerWidth - choiceWidth) / 2));
  const lines: string[] = [""];

  if (banner.length > 0) {
    for (const line of banner) {
      lines.push(line);
    }
    lines.push("");
  }

  if (options.panelLines !== undefined) {
    lines.push(...options.panelLines);
    return lines;
  }

  lines.push(renderStatusLine(options.state, options.lastExit, innerWidth));
  lines.push("");

  if (options.overlay === "options" && options.optionDrawer !== undefined) {
    lines.push(...renderOptionsDrawer(innerWidth, options.optionDrawer));
    return lines;
  }

  if (options.overlay === "fleet-menu") {
    lines.push(...renderFleetMenu(innerWidth, options.fleetMenu ?? { selectedIndex: 0 }));
    return lines;
  }

  for (const [index, entry] of options.cliOptions.entries()) {
    lines.push(renderChoiceLine({
      entry,
      index,
      innerWidth,
      leftPad: choiceLeftPad,
      selected: entry.id === options.selectedCliId,
    }));
  }

  if (options.editingModel !== undefined) {
    lines.push("");
    lines.push(centerText(`Model: ${formatModelEditValue(options.editingModel)}`, innerWidth));
    lines.push("");
    lines.push(centerText(STYLE.dim("Enter confirm  Esc cancel"), innerWidth));
    return lines;
  }

  lines.push("");

  const countsLine = renderCountsLine(options.loadedCounts, options.release, innerWidth);
  if (countsLine !== undefined) {
    lines.push(countsLine);
    const updateLine = renderUpdateLine(options.release, innerWidth);
    if (updateLine !== undefined) {
      lines.push(updateLine);
    }
    lines.push("");
  }

  lines.push(renderFooterHint(options.state, innerWidth));
  return lines;
}

function renderStatusLine(state: MissionControlStateKind, event: PtyExitEvent | undefined, innerWidth: number): string {
  const { text, tone } = getStatusText(state, event);
  return centerText(STYLE[tone](text), innerWidth);
}

function renderChoiceLine(options: {
  readonly entry: MissionControlCliOption;
  readonly index: number;
  readonly innerWidth: number;
  readonly leftPad: number;
  readonly selected: boolean;
}): string {
  const marker = options.selected ? STYLE.accent(SELECTED_MARKER) : STYLE.dim(IDLE_MARKER);
  const number = STYLE.muted(`${options.index + 1}.`);
  const label = colorizeProvider(options.entry.id, options.entry.label);
  const chips = options.entry.optionChips && options.entry.optionChips.length > 0
    ? STYLE.dim(`  [${options.entry.optionChips.join(" · ")}]`)
    : "";
  const prefix = `${" ".repeat(options.leftPad)}${marker} ${number} `;
  const remaining = Math.max(0, options.innerWidth - visibleWidth(prefix));
  return `${prefix}${truncateToWidth(`${label}${chips}`, remaining)}`;
}

function renderCountsLine(
  counts: MissionControlCounts | undefined,
  release: FleetCliRelease | undefined,
  innerWidth: number,
): string | undefined {
  const segments: string[] = [];
  if (counts !== undefined) {
    if (counts.carriers > 0) {
      segments.push(`${STYLE.success("✓")} ${STYLE.success(String(counts.carriers))} ${STYLE.dim(`carrier${counts.carriers === 1 ? "" : "s"}`)}`);
    }
    if (counts.wikiEntries > 0) {
      segments.push(`${STYLE.success("✓")} ${STYLE.success(String(counts.wikiEntries))} ${STYLE.dim(`wiki entr${counts.wikiEntries === 1 ? "y" : "ies"}`)}`);
    }
    if (counts.queuedPatches > 0) {
      segments.push(`${STYLE.warning("◆")} ${STYLE.warning(String(counts.queuedPatches))} ${STYLE.dim("queued")}`);
    }
  }
  if (release !== undefined && release.version.length > 0) {
    const channelLabel = release.channel === "stable"
      ? STYLE.success("stable")
      : STYLE.dim("local");
    segments.push(`${STYLE.dim(`v${release.version}`)} ${STYLE.dim("·")} ${channelLabel}`);
  }
  if (segments.length === 0) {
    return undefined;
  }
  const separator = STYLE.dim(COUNT_SEPARATOR);
  return centerText(segments.join(separator), innerWidth);
}

function renderUpdateLine(release: FleetCliRelease | undefined, innerWidth: number): string | undefined {
  if (release?.latestVersion === undefined || release.latestVersion === release.version) {
    return undefined;
  }
  return centerText(STYLE.warning(`◆ Update available — v${release.latestVersion} (latest)`), innerWidth);
}

function renderFooterHint(state: MissionControlStateKind, innerWidth: number): string {
  const hint = state === "launching"
    ? "Starting... please wait"
    : state === "ended" || state === "failed"
      ? "R relaunch  c choose CLI  C Carrier Roster  → model  O options  M menu  X exit Fleet"
      : "↑↓/j/k select  Enter start  c choose CLI  C Carrier Roster  → model  O options  M menu  X exit Fleet";
  return centerText(STYLE.dim(hint), innerWidth);
}

function renderOptionsDrawer(innerWidth: number, drawer: MissionControlOptionDrawerState): string[] {
  const values = drawer.resolved.values;
  const sources = drawer.resolved.sources;
  const systemPromptSource = values.native ? sources.native : sources.replaceSystemPrompt;
  const rows = [
    formatOptionDrawerRow(drawer.selectedRow === 0, "Mode", values.native ? "Native" : "Fleet prompt", sources.native, "[Space]"),
    formatOptionDrawerRow(drawer.selectedRow === 1, "System prompt", values.native ? "Native" : values.replaceSystemPrompt ? "Replace" : "Append", systemPromptSource, "[Space]"),
    formatOptionDrawerRow(drawer.selectedRow === 2, "Metaphor", values.enableMetaphor ? "Enabled" : "Off", sources.enableMetaphor, "[Space]"),
    formatOptionDrawerRow(drawer.selectedRow === 3, "Cursor sync", values.cursorSync ? "Enabled" : "Off", sources.cursorSync, "[Space]"),
  ];
  return [
    centerText(STYLE.accent("Options"), innerWidth),
    "",
    ...rows.map((row) => centerText(row, innerWidth)),
    ...(drawer.saveError ? ["", centerText(STYLE.error(`Save failed: ${drawer.saveError}`), innerWidth)] : []),
    "",
    centerText(STYLE.dim("↑↓ select  Space toggle  S save  R reset  Esc close"), innerWidth),
  ];
}

function renderFleetMenu(innerWidth: number, menu: MissionControlFleetMenuState): string[] {
  return [
    centerText(STYLE.accent("Fleet Menu"), innerWidth),
    "",
    ...FLEET_MENU_ITEMS.map((item, index) => centerText(formatMenuRow(index === menu.selectedIndex, item), innerWidth)),
    "",
    centerText(STYLE.dim("Enter open  Esc close"), innerWidth),
  ];
}

function getStatusText(state: MissionControlStateKind, event: PtyExitEvent | undefined): { readonly text: string; readonly tone: StatusTone } {
  if (state === "launching") {
    return { text: "Starting selected Agent CLI...", tone: "warning" };
  }

  if (state === "ended") {
    return { text: `Ended${formatExitEvent(event)}`, tone: "success" };
  }

  if (state === "failed") {
    return { text: `Failed${formatExitEvent(event)}`, tone: "error" };
  }

  return { text: "Choose an Agent CLI for the upper pane.", tone: "dim" };
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

function colorizeProvider(cliId: AgentCliId, text: string): string {
  const color = CARRIER_COLORS[cliId] ?? "";
  return color ? `${color}${text}${ANSI_RESET}` : text;
}

function computeChoiceWidth(cliOptions: readonly MissionControlCliOption[]): number {
  let maxLabelWidth = 0;
  for (const option of cliOptions) {
    const width = visibleWidth(option.label);
    if (width > maxLabelWidth) {
      maxLabelWidth = width;
    }
  }
  return CHOICE_INDENT + maxLabelWidth;
}

function formatOptionDrawerRow(selected: boolean, label: string, value: string, source: string, hint: string): string {
  const prefix = selected ? `${SELECTED_MARKER} ` : "  ";
  const selectedHint = selected ? hint : "";
  return `${prefix}${padEndVisible(label, OPTION_DRAWER_LABEL_WIDTH)}  ${padEndVisible(value, OPTION_DRAWER_VALUE_WIDTH)}  ${padEndVisible(source, OPTION_DRAWER_SOURCE_WIDTH)}  ${padEndVisible(selectedHint, OPTION_DRAWER_HINT_WIDTH)}`;
}

function formatMenuRow(selected: boolean, label: string): string {
  return `${selected ? SELECTED_MARKER : " "} ${label}`;
}

function formatModelEditValue(value: string): string {
  return `${value}|`;
}

function padEndVisible(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function paint(code: string, text: string): string {
  return paintBranded(code, text, true);
}
