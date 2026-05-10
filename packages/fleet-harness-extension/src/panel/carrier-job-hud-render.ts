/**
 * fleet — Carrier Job HUD 렌더러
 *
 * Editor 하단(belowEditor)에 등록된 캐리어 strip과 캐리어별 active job 트리를 렌더링합니다.
 */

import type { Theme } from "@sbluemin/fleet-coding-agent";
import { truncateToWidth, visibleWidth } from "@sbluemin/fleet-tui";
import {
  ANSI_RESET,
  PANEL_DIM_COLOR,
  PANEL_RGB,
  SPINNER_FRAMES,
  SYM_INDICATOR,
  TASKFORCE_BADGE_COLOR,
  SQUADRON_BADGE_COLOR,
  CLI_DISPLAY_NAMES,
} from "../fleet-core-facades.js";
import { getConfiguredTaskForceBackends } from "../fleet-core-facades.js";
import {
  isCarrierOnline,
  isSquadronCarrierEnabled,
  resolveCarrierColor,
  resolveCarrierDisplayName,
  resolveCarrierRgb,
} from "../tools.js";
import { renderBlockLines } from "./message-render.js";
import { waveText } from "./panel-render.js";
import { getActiveJobs, getPanelRuns, getState, makeFooterCols } from "./state.js";
import type { PanelJobViewModel, PanelTrackViewModel } from "./view-model.js";
import { buildPanelViewModel } from "./view-model.js";

interface CarrierHudTile {
  carrierId: string;
  displayName: string;
  activeJobCount: number;
  activeTrackCount: number;
  online: boolean;
  taskForceBackendCount: number;
  squadronEnabled: boolean;
}

const MAX_EXPANDED_STREAM_LINES = 1;
const MAX_EXPANDED_TOTAL_LINES = 8;
const SEPARATOR_VIS_W = 3;
const COLOR_DONE = "\x1b[38;2;80;200;120m";
const COLOR_ERROR = "\x1b[38;2;255;80;80m";
const DISABLED_COLOR = "\x1b[38;2;100;100;100m";
const STREAM_PREFIX = "  ";
const STREAM_INLINE_COLOR = "\x1b[38;2;100;210;245m";
const FOCUS_BG_FACTOR = 0.12;
const FOCUS_BG_BASE = 12;
const JOB_NODE_PREFIX = " ";

const KIND_LABELS: Record<string, string> = {
  carrier: "Carrier",
  sortie: "Sortie",
  squadron: "Squadron",
  taskforce: "Taskforce",
};

export function renderCarrierJobHud(width: number, frame: number, theme?: Theme): string[] {
  const carriers = buildCarrierTiles();
  if (carriers.length === 0) return [];

  const state = getState();
  const cursor = clampCursor(state.jobBarCursor, carriers.length);
  const expandedCarrierId = carriers.some((carrier) => carrier.carrierId === state.jobBarExpandedJobId)
    ? state.jobBarExpandedJobId
    : null;

  if (expandedCarrierId) {
    return renderCarrierHudExpanded(width, carriers, cursor, expandedCarrierId, frame, theme);
  }

  return renderCarrierHudStrip(width, carriers, cursor, frame, theme);
}

function renderCarrierHudStrip(
  width: number,
  carriers: CarrierHudTile[],
  cursor: number,
  frame: number,
  theme: Theme | undefined,
): string[] {
  const tiles = carriers.map((carrier, index) => formatCarrierTile(carrier, index === cursor, frame));
  return [centerLine(tiles.join(tileSeparator(theme)), width)];
}

function renderCarrierHudExpanded(
  width: number,
  carriers: CarrierHudTile[],
  cursor: number,
  expandedCarrierId: string,
  frame: number,
  theme: Theme | undefined,
): string[] {
  const expandedIdx = carriers.findIndex((carrier) => carrier.carrierId === expandedCarrierId);
  if (expandedIdx < 0) return renderCarrierHudStrip(width, carriers, cursor, frame, theme);

  const tiles = carriers.map((carrier, index) => formatCarrierTile(carrier, index === cursor, frame));
  const offsets = computeTileOffsets(tiles);
  const stripLine = tiles.join(tileSeparator(theme));
  const stripPadding = centerPadding(stripLine, width);
  const indent = " ".repeat(stripPadding + (offsets[expandedIdx] ?? 0));
  const lines = [" ".repeat(stripPadding) + stripLine];
  appendCarrierJobTree(lines, width, expandedCarrierId, indent, frame, theme);
  return lines.map((line) => truncateToWidth(line, width));
}

function appendCarrierJobTree(
  lines: string[],
  width: number,
  carrierId: string,
  indent: string,
  frame: number,
  theme: Theme | undefined,
): void {
  const jobs = buildCarrierJobViewModels(carrierId);
  let remaining = MAX_EXPANDED_TOTAL_LINES - 1;

  if (jobs.length === 0) {
    lines.push(truncateToWidth(`${indent}${STREAM_PREFIX}${border(theme, "└─")} ${PANEL_DIM_COLOR}No active jobs${ANSI_RESET}`, width));
    return;
  }

  for (let jobIndex = 0; jobIndex < jobs.length && remaining > 0; jobIndex++) {
    const job = jobs[jobIndex];
    if (!job) continue;
    const isLastJob = jobIndex === jobs.length - 1;
    const jobBranch = isLastJob ? "└─" : "├─";
    const jobColor = resolveCarrierColor(job.ownerCarrierId);
    const jobLabel = `${kindDisplayName(job.kind)} · ${job.label}`;
    lines.push(truncateToWidth(
      `${indent}${JOB_NODE_PREFIX}${border(theme, jobBranch)} ${jobIcon(job, frame)} ${jobColor}${jobLabel}${ANSI_RESET}`,
      width,
    ));
    remaining--;
    appendTrackTree(lines, width, job, indent, isLastJob, frame, theme, remaining);
    remaining = MAX_EXPANDED_TOTAL_LINES - lines.length;
  }
}

function appendTrackTree(
  lines: string[],
  width: number,
  job: PanelJobViewModel,
  indent: string,
  isLastJob: boolean,
  frame: number,
  theme: Theme | undefined,
  budget: number,
): void {
  const fallbackColor = resolveCarrierColor(job.ownerCarrierId);
  const childIndent = `${indent}${JOB_NODE_PREFIX}${isLastJob ? "  " : "│ "}`;
  let remaining = budget;

  for (let trackIndex = 0; trackIndex < job.tracks.length && remaining > 0; trackIndex++) {
    const track = job.tracks[trackIndex];
    if (!track) continue;
    const isLastTrack = trackIndex === job.tracks.length - 1;
    const branch = isLastTrack ? "└─" : "├─";
    const trackColor = resolveCarrierColor(track.displayCli) ?? fallbackColor;
    const icon = trackStatusIcon(track, frame, trackColor);
    const name = `${trackColor}${trackDisplayName(track)}${ANSI_RESET}`;
    const inline = !track.isComplete ? trackInlineBlock(track) : "";
    lines.push(truncateToWidth(
      `${childIndent}${border(theme, branch)} ${icon} ${name}${inline}`,
      width,
    ));
    remaining--;
  }
}

function buildCarrierTiles(): CarrierHudTile[] {
  const activeJobs = getActiveJobs();
  return makeFooterCols().map((col) => {
    const activeCarrierJobs = activeJobs.filter((job) => job.ownerCarrierId === col.cli);
    return {
      carrierId: col.cli,
      displayName: resolveCarrierDisplayName(col.cli),
      activeJobCount: activeCarrierJobs.length,
      activeTrackCount: activeCarrierJobs.reduce((sum, job) => sum + job.tracks.length, 0),
      online: isCarrierOnline(col.cli),
      taskForceBackendCount: getConfiguredTaskForceBackends(col.cli).length,
      squadronEnabled: isSquadronCarrierEnabled(col.cli),
    };
  });
}

function buildCarrierJobViewModels(carrierId: string): PanelJobViewModel[] {
  const jobs = getActiveJobs().filter((job) => job.ownerCarrierId === carrierId && job.status === "active");
  return buildPanelViewModel(jobs, getPanelRuns(), { maxTrackBlocks: MAX_EXPANDED_STREAM_LINES });
}

function clampCursor(cursor: number, carrierCount: number): number {
  if (carrierCount <= 0) return -1;
  if (cursor < 0) return -1;
  return Math.min(cursor, carrierCount - 1);
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

function computeTileOffsets(tiles: string[]): number[] {
  const offsets: number[] = [];
  let pos = 0;
  for (let i = 0; i < tiles.length; i++) {
    offsets.push(pos);
    pos += visibleWidth(tiles[i]);
    if (i < tiles.length - 1) pos += SEPARATOR_VIS_W;
  }
  return offsets;
}

function formatCarrierTile(carrier: CarrierHudTile, focused: boolean, frame: number): string {
  const carrierColor = carrier.online ? resolveCarrierColor(carrier.carrierId) : DISABLED_COLOR;
  const icon = carrierStatusIcon(carrier, frame, carrierColor);
  const hasActiveJob = carrier.activeJobCount > 0;
  const suffix = `${carrierBadges(carrier)}${carrierActivityBadge(carrier)}`;
  const prefix = `${icon} `;

  if (focused) {
    const rgb = resolveCarrierRgb(carrier.carrierId) ?? PANEL_RGB;
    const bg = carrierBgEscape(rgb);
    const focusedName = hasActiveJob
      ? waveText(carrier.displayName, rgb, frame)
      : `${carrierColor}${carrier.displayName}${ANSI_RESET}`;
    const focusedLabel = `${focusedName}${suffix}`;
    return `${bg}${reapplyBg(prefix, bg)}${reapplyBg(focusedLabel, bg)} ${ANSI_RESET}`;
  }

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
  const sqBadgeColor = disabledColor ?? SQUADRON_BADGE_COLOR;
  const tfBadge = carrier.taskForceBackendCount >= 2
    ? ` ${tfBadgeColor}[TF:${carrier.taskForceBackendCount}]${ANSI_RESET}`
    : "";
  const sqBadge = carrier.squadronEnabled ? ` ${sqBadgeColor}[SQ]${ANSI_RESET}` : "";
  return `${tfBadge}${sqBadge}`;
}

function carrierActivityBadge(carrier: CarrierHudTile): string {
  if (carrier.activeJobCount <= 0) return "";
  const trackSuffix = carrier.activeTrackCount > 0 ? `:${carrier.activeTrackCount}` : "";
  return ` ${PANEL_DIM_COLOR}[${carrier.activeJobCount}${trackSuffix}]${ANSI_RESET}`;
}

function carrierBgEscape(rgb: readonly [number, number, number]): string {
  const r = Math.round(rgb[0] * FOCUS_BG_FACTOR + FOCUS_BG_BASE);
  const g = Math.round(rgb[1] * FOCUS_BG_FACTOR + FOCUS_BG_BASE);
  const b = Math.round(rgb[2] * FOCUS_BG_FACTOR + FOCUS_BG_BASE);
  return `\x1b[48;2;${r};${g};${b}m`;
}

function reapplyBg(text: string, bg: string): string {
  return text.replace(/\x1b\[0m/g, `\x1b[0m${bg}`);
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
