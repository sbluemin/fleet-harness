import { ANSI_RESET } from "../styles/index.js";
import { getCarrierAnsi } from "../styles/carriers.js";
import { truncateToWidth, visibleWidth, type PtyExitEvent } from "../controls/index.js";

import type { AgentCliId } from "../agent-cli/types.js";
import { computeBlockLeftPad, maxVisibleWidth } from "./layout.js";
import type { FleetCliRelease } from "../release.js";
import type { MissionControlCounts } from "./loaded-counts.js";
import { MISSION_CONTROL_THEME } from "./theme.js";
import type { MissionControlCliOption, MissionControlStateKind } from "./types.js";
import { buildFleetBanner, centerText } from "./welcome.js";

export { MISSION_CONTROL_THEME } from "./theme.js";

interface MissionControlRenderOptions {
  readonly bannerPhase?: number;
  readonly cliOptions: readonly MissionControlCliOption[];
  readonly lastLaunchError?: string;
  readonly lastLaunchWarning?: string;
  readonly lastExit: PtyExitEvent | undefined;
  readonly loadedCounts: MissionControlCounts | undefined;
  readonly panelLines?: readonly string[];
  readonly release: FleetCliRelease | undefined;
  readonly selectedCliId: AgentCliId;
  readonly state: MissionControlStateKind;
}

type StatusTone = "dim" | "error" | "success" | "warning";

const SELECTED_MARKER = "▸";
const IDLE_MARKER = " ";
const CHOICE_INDENT = 4;
const COUNT_SEPARATOR = "  ·  ";

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
  const banner = buildFleetBanner(innerWidth, options.bannerPhase ?? 0);
  const choiceWidth = CHOICE_INDENT + maxVisibleWidth(options.cliOptions.map((option) => option.label));
  const choiceLeftPad = computeBlockLeftPad(choiceWidth, innerWidth);
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

  lines.push(renderStatusLine(options.state, options.lastExit, options.lastLaunchError, innerWidth));
  if (options.lastLaunchWarning !== undefined) {
    lines.push(centerText(STYLE.warning(`Warning: ${options.lastLaunchWarning}`), innerWidth));
  }
  lines.push("");

  for (const [index, entry] of options.cliOptions.entries()) {
    lines.push(renderChoiceLine({
      entry,
      index,
      innerWidth,
      leftPad: choiceLeftPad,
      selected: entry.id === options.selectedCliId,
    }));
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

function renderStatusLine(
  state: MissionControlStateKind,
  event: PtyExitEvent | undefined,
  launchError: string | undefined,
  innerWidth: number,
): string {
  const { text, tone } = getStatusText(state, event, launchError);
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
  const prefix = `${" ".repeat(options.leftPad)}${marker} ${number} `;
  const remaining = Math.max(0, options.innerWidth - visibleWidth(prefix));
  return `${prefix}${truncateToWidth(label, remaining)}`;
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
      ? "Use Launcher Root actions to relaunch, configure, or exit Fleet"
      : "↑↓ select  Enter open";
  return centerText(STYLE.dim(hint), innerWidth);
}

function getStatusText(
  state: MissionControlStateKind,
  event: PtyExitEvent | undefined,
  launchError: string | undefined,
): { readonly text: string; readonly tone: StatusTone } {
  if (state === "launching") {
    return { text: "Starting selected Agent CLI...", tone: "warning" };
  }

  if (state === "ended") {
    return { text: `Ended${formatExitEvent(event)}`, tone: "success" };
  }

  if (state === "failed") {
    if (launchError !== undefined) {
      return { text: `Failed: ${launchError}`, tone: "error" };
    }
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
  const color = getCarrierAnsi(cliId);
  return color ? `${color}${text}${ANSI_RESET}` : text;
}
