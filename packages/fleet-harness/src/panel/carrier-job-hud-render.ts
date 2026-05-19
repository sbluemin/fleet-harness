/**
 * fleet — Carrier Job HUD 렌더러
 *
 * aboveEditor 캐리어 명단 strip과 belowEditor 확장 작업 상세를 렌더링합니다.
 */

import type { Theme } from "@sbluemin/fleet-coding-agent";
import { truncateToWidth, visibleWidth } from "@sbluemin/fleet-tui";
import {
  ANSI_RESET,
  PANEL_DIM_COLOR,
  SPINNER_FRAMES,
  SYM_INDICATOR,
  TASKFORCE_BADGE_COLOR,
  CLI_DISPLAY_NAMES,
} from "../fleet-core-facades.js";
import { getConfiguredTaskForceBackendsFromSnapshot, readStatesSnapshot } from "../fleet-core-facades.js";
import {
  isCarrierOnline,
  resolveCarrierColor,
  resolveCarrierDisplayName,
  resolveCarrierRgb,
} from "../tools.js";
import { renderBlockLines } from "./message-render.js";
import { waveText } from "./panel-render.js";
import { getActiveJobs, getPanelRuns, getState, makeFooterCols } from "./state.js";
import type { CarrierJobGroupViewModel, PanelJobViewModel, PanelTrackViewModel } from "./view-model.js";
import { buildCarrierJobGroups, buildPanelViewModel } from "./view-model.js";

interface CarrierHudTile {
  carrierId: string;
  displayName: string;
  activeJobCount: number;
  activeTrackCount: number;
  online: boolean;
  taskForceBackendCount: number;
}

const MAX_EXPANDED_STREAM_LINES = 1;
export const MAX_WIDGET_LINES = 10;
const COLOR_DONE = "\x1b[38;2;80;200;120m";
const COLOR_ERROR = "\x1b[38;2;255;80;80m";
const DISABLED_COLOR = "\x1b[38;2;100;100;100m";
const STREAM_PREFIX = "  ";
const STREAM_INLINE_COLOR = "\x1b[38;2;100;210;245m";

const KIND_LABELS: Record<string, string> = {
  carrier: "Carrier",
  sortie: "Sortie",
  taskforce: "Taskforce",
};

export function renderCarrierJobHud(width: number, frame: number, theme?: Theme): string[] {
  if (getState().widgetMode === "expanded" && !getState().expanded) {
    return renderCarrierJobHudExpanded(width, frame, theme);
  }
  return renderCarrierJobHudStrip(width, frame, theme);
}

export function renderCarrierJobHudStrip(width: number, frame: number, theme?: Theme): string[] {
  const carriers = buildCarrierTiles();
  if (carriers.length === 0) return [];
  return renderCarrierHudStrip(width, carriers, frame, theme);
}

export function renderCarrierJobHudExpanded(width: number, frame: number, theme?: Theme): string[] {
  const lines: string[] = [];
  const jobs = buildActiveJobViewModels();

  if (jobs.length === 0) {
    lines.push(truncateToWidth(`${STREAM_PREFIX}${border(theme, "└─")} ${PANEL_DIM_COLOR}No active jobs${ANSI_RESET}`, width));
    return lines.slice(0, MAX_WIDGET_LINES);
  }

  appendWidgetJobSummary(lines, width, jobs, frame, theme);
  return lines.slice(0, MAX_WIDGET_LINES).map((line) => truncateToWidth(line, width));
}

function renderCarrierHudStrip(
  width: number,
  carriers: CarrierHudTile[],
  frame: number,
  theme: Theme | undefined,
): string[] {
  const tiles = carriers.map((carrier) => formatCarrierTile(carrier, frame));
  return [centerLine(tiles.join(tileSeparator(theme)), width)];
}

function appendWidgetJobSummary(
  lines: string[],
  width: number,
  jobs: PanelJobViewModel[],
  frame: number,
  theme: Theme | undefined,
): void {
  const groups = buildCarrierJobGroups(jobs, makeFooterCols().map((col) => col.cli), resolveCarrierDisplayName);
  for (let groupIndex = 0; groupIndex < groups.length && lines.length < MAX_WIDGET_LINES; groupIndex++) {
    const group = groups[groupIndex];
    if (!group || group.jobs.length === 0) continue;
    const groupColor = resolveCarrierColor(group.carrierId);
    lines.push(truncateToWidth(
      `${STREAM_PREFIX}${border(theme, "├─")} ${groupIcon(group, frame)} ${groupColor}Carrier ${group.displayName}${ANSI_RESET}`,
      width,
    ));

    for (let jobIndex = 0; jobIndex < group.jobs.length && lines.length < MAX_WIDGET_LINES; jobIndex++) {
      const job = group.jobs[jobIndex];
      if (!job) continue;
      const jobColor = resolveCarrierColor(job.ownerCarrierId);
      const inline = shouldInlineSingleTrack(job) && job.tracks[0] && !job.tracks[0].isComplete
        ? trackInlineBlock(job.tracks[0])
        : "";
      const stats = shouldInlineSingleTrack(job) && job.tracks[0] ? widgetTrackStats(job.tracks[0]) : "";
      lines.push(truncateToWidth(
        `${STREAM_PREFIX}  ${border(theme, "├─")} ${jobIcon(job, frame)} ${jobColor}${jobDisplayLabel(job)}${ANSI_RESET}${stats}${inline}`,
        width,
      ));

      if (shouldInlineSingleTrack(job)) continue;
      appendTrackRows(lines, width, job, jobColor, frame, theme);
    }
  }
}

function appendTrackRows(
  lines: string[],
  width: number,
  job: PanelJobViewModel,
  jobColor: string,
  frame: number,
  theme: Theme | undefined,
): void {
  for (let trackIndex = 0; trackIndex < job.tracks.length && lines.length < MAX_WIDGET_LINES; trackIndex++) {
    const track = job.tracks[trackIndex];
    if (!track) continue;
    const trackColor = resolveCarrierColor(track.displayCli) ?? jobColor;
    const icon = trackStatusIcon(track, frame, trackColor);
    const stats = widgetTrackStats(track);
    const inline = !track.isComplete ? trackInlineBlock(track) : "";
    lines.push(truncateToWidth(
      `${STREAM_PREFIX}    ${border(theme, "└─")} ${icon} ${trackColor}${trackDisplayName(track)}${ANSI_RESET}${stats}${inline}`,
      width,
    ));
  }
}

function buildCarrierTiles(): CarrierHudTile[] {
  const activeJobs = getActiveJobs();
  const snapshot = readStatesSnapshot();
  return makeFooterCols().map((col) => {
    const activeCarrierJobs = activeJobs.filter((job) => job.ownerCarrierId === col.cli);
    return {
      carrierId: col.cli,
      displayName: resolveCarrierDisplayName(col.cli),
      activeJobCount: activeCarrierJobs.length,
      activeTrackCount: activeCarrierJobs.reduce((sum, job) => sum + job.tracks.length, 0),
      online: isCarrierOnline(col.cli),
      taskForceBackendCount: getConfiguredTaskForceBackendsFromSnapshot(snapshot, col.cli).length,
    };
  });
}

function buildActiveJobViewModels(): PanelJobViewModel[] {
  return buildPanelViewModel(getActiveJobs(), getPanelRuns(), { maxTrackBlocks: MAX_EXPANDED_STREAM_LINES });
}

function border(theme: Theme | undefined, text: string): string {
  return theme?.fg("border", text) ?? `${PANEL_DIM_COLOR}${text}${ANSI_RESET}`;
}

function tileSeparator(theme: Theme | undefined): string {
  return ` ${border(theme, "│")} `;
}

function centerLine(line: string, width: number): string {
  return truncateToWidth(" ".repeat(centerPadding(line, width)) + line, width);
}

function centerPadding(line: string, width: number): number {
  return Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
}

function formatCarrierTile(carrier: CarrierHudTile, frame: number): string {
  const carrierColor = carrier.online ? resolveCarrierColor(carrier.carrierId) : DISABLED_COLOR;
  const icon = carrierStatusIcon(carrier, frame, carrierColor);
  const hasActiveJob = carrier.activeJobCount > 0;
  const suffix = `${carrierBadges(carrier)}${carrierActivityBadge(carrier)}`;
  const prefix = `${icon} `;

  if (hasActiveJob && carrier.online) {
    return `${prefix}${waveText(carrier.displayName, resolveCarrierRgb(carrier.carrierId), frame)}${suffix}${ANSI_RESET}`;
  }

  return `${prefix}${carrierColor}${carrier.displayName}${suffix}${ANSI_RESET}`;
}

function carrierStatusIcon(carrier: CarrierHudTile, frame: number, color?: string): string {
  if (!carrier.online) return `${DISABLED_COLOR}○${ANSI_RESET}`;
  if (carrier.activeJobCount > 0) {
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
  }
  return color ? `${color}○${ANSI_RESET}` : "○";
}

function carrierBadges(carrier: CarrierHudTile): string {
  const disabledColor = carrier.online ? null : DISABLED_COLOR;
  const tfBadgeColor = disabledColor ?? TASKFORCE_BADGE_COLOR;
  const tfBadge = carrier.taskForceBackendCount >= 2
    ? ` ${tfBadgeColor}[TF:${carrier.taskForceBackendCount}]${ANSI_RESET}`
    : "";
  return tfBadge;
}

function carrierActivityBadge(carrier: CarrierHudTile): string {
  if (carrier.activeJobCount <= 0) return "";
  const trackSuffix = carrier.activeTrackCount > 0 ? `:${carrier.activeTrackCount}` : "";
  return ` ${PANEL_DIM_COLOR}[${carrier.activeJobCount}${trackSuffix}]${ANSI_RESET}`;
}

function kindDisplayName(kind: string): string {
  return KIND_LABELS[kind] ?? capitalize(kind);
}

function capitalize(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function jobIcon(job: PanelJobViewModel, frame: number): string {
  if (job.status === "active") {
    const color = resolveCarrierColor(job.ownerCarrierId);
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
  }
  if (job.status === "done") return `${COLOR_DONE}${SYM_INDICATOR}${ANSI_RESET}`;
  if (job.status === "error" || job.status === "aborted") return `${COLOR_ERROR}${SYM_INDICATOR}${ANSI_RESET}`;
  return `${PANEL_DIM_COLOR}○${ANSI_RESET}`;
}

function groupIcon(group: CarrierJobGroupViewModel, frame: number): string {
  if (group.status === "active") {
    const color = resolveCarrierColor(group.carrierId);
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
  }
  if (group.status === "done") return `${COLOR_DONE}${SYM_INDICATOR}${ANSI_RESET}`;
  if (group.status === "error" || group.status === "aborted") return `${COLOR_ERROR}${SYM_INDICATOR}${ANSI_RESET}`;
  return `${PANEL_DIM_COLOR}○${ANSI_RESET}`;
}

function jobDisplayLabel(job: PanelJobViewModel): string {
  return job.kind === "carrier" ? job.label : `${kindDisplayName(job.kind)} · ${job.label}`;
}

function shouldInlineSingleTrack(job: PanelJobViewModel): boolean {
  return job.kind === "carrier" && job.tracks.length === 1;
}

function trackStatusIcon(track: PanelTrackViewModel, frame: number, color?: string): string {
  if (track.isComplete) {
    if (track.status === "err") return `${COLOR_ERROR}${SYM_INDICATOR}${ANSI_RESET}`;
    return `${COLOR_DONE}${SYM_INDICATOR}${ANSI_RESET}`;
  }
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
}

function trackDisplayName(track: PanelTrackViewModel): string {
  if (track.kind === "backend") {
    return CLI_DISPLAY_NAMES[track.displayCli] ?? capitalize(track.displayCli);
  }
  return track.displayName;
}

function trackInlineBlock(track: PanelTrackViewModel): string {
  if (track.blocks.length === 0) return "";
  const rendered = renderBlockLines(track.blocks).filter((line) => line.text.trim());
  const latest = rendered[rendered.length - 1];
  if (!latest) return "";
  return ` ${PANEL_DIM_COLOR}·${ANSI_RESET} ${STREAM_INLINE_COLOR}${latest.text.trim()}${ANSI_RESET}`;
}

function widgetTrackStats(track: PanelTrackViewModel): string {
  const parts: string[] = [];
  if (track.toolCallCount > 0) parts.push(`${track.toolCallCount}T`);
  if (track.textLineCount > 0) parts.push(`${track.textLineCount}L`);
  return parts.length > 0 ? ` ${PANEL_DIM_COLOR}[${parts.join("·")}]${ANSI_RESET}` : "";
}
