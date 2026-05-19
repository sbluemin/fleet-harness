import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";
import { truncateToWidth, visibleWidth, type FleetPtyTheme } from "@sbluemin/fleet-tui/pty";

import {
  isCarrierOnline,
  resolveCarrierColor,
  resolveCarrierDisplayName,
  resolveCarrierRgb,
} from "./carrier-helpers.js";
import {
  ANSI_RESET,
  CLI_DISPLAY_NAMES,
  getConfiguredTaskForceBackendsFromSnapshot,
  PANEL_DIM_COLOR,
  readStatesSnapshot,
  SPINNER_FRAMES,
  SYM_INDICATOR,
  SYM_THINKING,
  TASKFORCE_BADGE_COLOR,
} from "./facade.js";
import type { CarrierJobGroupViewModel, ColBlock, PanelJob, PanelJobViewModel, PanelRunViewModelSource, PanelTrackViewModel } from "./job-bar-view-model.js";
import { buildCarrierJobGroups, buildPanelViewModel } from "./job-bar-view-model.js";

export type CarrierJobHudMode = "expanded" | "strip";

export interface CarrierHudTile {
  readonly activeJobCount: number;
  readonly activeTrackCount: number;
  readonly carrierId: string;
  readonly color: string;
  readonly displayName: string;
  readonly online: boolean;
  readonly rgb: [number, number, number];
  readonly taskForceBackendCount: number;
}

export interface CarrierJobHudRenderOptions {
  readonly frame: number;
  readonly jobs?: readonly PanelJob[];
  readonly mode?: CarrierJobHudMode;
  readonly runs?: ReadonlyMap<string, PanelRunViewModelSource>;
  readonly theme?: FleetPtyTheme;
  readonly width: number;
  readonly rt: FleetCoreRuntimeContext;
}

export type BlockLineType =
  | "fold"
  | "text"
  | "thought"
  | "tool-error"
  | "tool-result"
  | "tool-title";

export interface BlockLine {
  readonly suffix?: string;
  readonly suffixType?: BlockLineType;
  readonly text: string;
  readonly type: BlockLineType;
}

const MAX_EXPANDED_STREAM_LINES = 1;
const MAX_WIDGET_LINES = 10;
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

export function renderCarrierJobHud(options: CarrierJobHudRenderOptions): string[] {
  if (options.mode === "expanded") {
    return renderCarrierJobHudExpanded(options);
  }
  return renderCarrierJobHudStrip(options);
}

export function renderCarrierJobHudStrip(options: CarrierJobHudRenderOptions): string[] {
  const carriers = buildCarrierTiles(options.rt, getActiveJobs(options.jobs));
  if (carriers.length === 0) return [];
  return renderCarrierHudStrip(options.width, carriers, options.frame, options.rt, options.theme);
}

export function renderCarrierJobHudExpanded(options: CarrierJobHudRenderOptions): string[] {
  const lines: string[] = [];
  const jobs = buildActiveJobViewModels(options.jobs, options.runs);

  if (jobs.length === 0) {
    lines.push(truncateToWidth(
      `${STREAM_PREFIX}${border(options.rt, options.theme, "└─")} ${PANEL_DIM_COLOR(options.rt)}No active jobs${ANSI_RESET}`,
      options.width,
    ));
    return lines.slice(0, MAX_WIDGET_LINES);
  }

  appendWidgetJobSummary(lines, options.width, jobs, options.frame, options.rt, options.theme);
  return lines.slice(0, MAX_WIDGET_LINES).map((line) => truncateToWidth(line, options.width));
}

export function waveText(
  text: string,
  rgb: [number, number, number],
  frame: number,
  startOffset = 0,
  options?: { readonly allowDim?: boolean; readonly speed?: number },
): string {
  const [r, g, b] = rgb;
  const speed = options?.speed ?? 0.35;
  const allowDim = options?.allowDim ?? false;
  let idx = startOffset;
  let result = "";

  for (const ch of text) {
    const phase = idx * 0.4 - frame * speed;
    const raw = Math.sin(phase);

    if (allowDim) {
      const bright = Math.pow(Math.max(0, raw), 3) * 0.4;
      const dim = Math.min(0, raw) * 0.25;
      const factor = bright + dim;
      const cr = Math.min(255, Math.max(0, Math.round(factor >= 0 ? r + (255 - r) * factor : r + r * factor)));
      const cg = Math.min(255, Math.max(0, Math.round(factor >= 0 ? g + (255 - g) * factor : g + g * factor)));
      const cb = Math.min(255, Math.max(0, Math.round(factor >= 0 ? b + (255 - b) * factor : b + b * factor)));
      result += `\x1b[38;2;${cr};${cg};${cb}m${ch}`;
    } else {
      const wave = Math.max(0, raw);
      const boost = wave * 0.5;
      const cr = Math.min(255, Math.round(r + (255 - r) * boost));
      const cg = Math.min(255, Math.round(g + (255 - g) * boost));
      const cb = Math.min(255, Math.round(b + (255 - b) * boost));
      result += `\x1b[38;2;${cr};${cg};${cb}m${ch}`;
    }
    idx++;
  }

  return result;
}

export function renderBlockLines(rt: FleetCoreRuntimeContext, blocks: readonly ColBlock[]): BlockLine[] {
  const lines: BlockLine[] = [];

  for (const block of blocks) {
    if (block.type === "thought") {
      const trimmed = block.text.replace(/^\n+/, "");
      if (!trimmed) continue;
      trimmed.split("\n").forEach((line, i) => {
        lines.push({
          text: i === 0 ? `${SYM_THINKING(rt)} ${line}` : `  ${line}`,
          type: "thought",
        });
      });
      continue;
    }

    if (block.type === "text") {
      const trimmed = block.text.replace(/^\n+/, "");
      if (!trimmed) continue;
      trimmed.split("\n").forEach((line, i) => {
        lines.push({
          text: i === 0 ? `${SYM_INDICATOR(rt)} ${line}` : `  ${line}`,
          type: "text",
        });
      });
      continue;
    }

    const isError = block.status === "failed" || block.status === "error";
    const isFinished = block.status === "completed" || block.status === "failed" || block.status === "error";
    const line: BlockLine = {
      text: `${SYM_INDICATOR(rt)} ${block.title}`,
      type: isError ? "tool-error" : "tool-title",
    };
    if (isFinished) {
      lines.push({
        ...line,
        suffix: ` ${block.status}`,
        suffixType: isError ? "tool-error" : "tool-result",
      });
    } else {
      lines.push(line);
    }
  }

  return lines;
}

function renderCarrierHudStrip(
  width: number,
  carriers: CarrierHudTile[],
  frame: number,
  rt: FleetCoreRuntimeContext,
  theme: FleetPtyTheme | undefined,
): string[] {
  const tiles = carriers.map((carrier) => formatCarrierTile(rt, carrier, frame));
  return [centerLine(tiles.join(tileSeparator(theme)), width)];
}

function appendWidgetJobSummary(
  lines: string[],
  width: number,
  jobs: PanelJobViewModel[],
  frame: number,
  rt: FleetCoreRuntimeContext,
  theme: FleetPtyTheme | undefined,
): void {
  const groups = buildCarrierJobGroups(
    jobs,
    rt.admiral.carrier.getRegisteredOrder(),
    (carrierId) => resolveCarrierDisplayName(rt, carrierId),
  );
  for (let groupIndex = 0; groupIndex < groups.length && lines.length < MAX_WIDGET_LINES; groupIndex++) {
    const group = groups[groupIndex];
    if (!group || group.jobs.length === 0) continue;
    const groupColor = resolveCarrierColor(rt, group.carrierId);
    lines.push(truncateToWidth(
      `${STREAM_PREFIX}${border(rt, theme, "├─")} ${groupIcon(rt, group, frame)} ${groupColor}Carrier ${group.displayName}${ANSI_RESET}`,
      width,
    ));

    for (let jobIndex = 0; jobIndex < group.jobs.length && lines.length < MAX_WIDGET_LINES; jobIndex++) {
      const job = group.jobs[jobIndex];
      if (!job) continue;
      const jobColor = resolveCarrierColor(rt, job.ownerCarrierId);
      const inline = shouldInlineSingleTrack(job) && job.tracks[0] && !job.tracks[0].isComplete
        ? trackInlineBlock(rt, job.tracks[0])
        : "";
      const stats = shouldInlineSingleTrack(job) && job.tracks[0] ? widgetTrackStats(rt, job.tracks[0]) : "";
      lines.push(truncateToWidth(
        `${STREAM_PREFIX}  ${border(rt, theme, "├─")} ${jobIcon(rt, job, frame)} ${jobColor}${jobDisplayLabel(job)}${ANSI_RESET}${stats}${inline}`,
        width,
      ));

      if (shouldInlineSingleTrack(job)) continue;
      appendTrackRows(lines, width, job, jobColor, frame, rt, theme);
    }
  }
}

function appendTrackRows(
  lines: string[],
  width: number,
  job: PanelJobViewModel,
  jobColor: string,
  frame: number,
  rt: FleetCoreRuntimeContext,
  theme: FleetPtyTheme | undefined,
): void {
  for (let trackIndex = 0; trackIndex < job.tracks.length && lines.length < MAX_WIDGET_LINES; trackIndex++) {
    const track = job.tracks[trackIndex];
    if (!track) continue;
    const trackColor = resolveCarrierColor(rt, track.displayCli) ?? jobColor;
    const icon = trackStatusIcon(rt, track, frame, trackColor);
    const stats = widgetTrackStats(rt, track);
    const inline = !track.isComplete ? trackInlineBlock(rt, track) : "";
    lines.push(truncateToWidth(
      `${STREAM_PREFIX}    ${border(rt, theme, "└─")} ${icon} ${trackColor}${trackDisplayName(rt, track)}${ANSI_RESET}${stats}${inline}`,
      width,
    ));
  }
}

function buildCarrierTiles(rt: FleetCoreRuntimeContext, activeJobs: readonly PanelJob[]): CarrierHudTile[] {
  const snapshot = readStatesSnapshot(rt);
  return rt.admiral.carrier.getRegisteredOrder().map((carrierId) => {
    const activeCarrierJobs = activeJobs.filter((job) => job.ownerCarrierId === carrierId);
    return {
      activeJobCount: activeCarrierJobs.length,
      activeTrackCount: activeCarrierJobs.reduce((sum, job) => sum + job.tracks.length, 0),
      carrierId,
      color: resolveCarrierColor(rt, carrierId),
      displayName: resolveCarrierDisplayName(rt, carrierId),
      online: isCarrierOnline(rt, carrierId),
      rgb: resolveCarrierRgb(rt, carrierId),
      taskForceBackendCount: getConfiguredTaskForceBackendsFromSnapshot(rt, snapshot, carrierId).length,
    };
  });
}

function buildActiveJobViewModels(
  jobs: readonly PanelJob[] | undefined,
  runs: ReadonlyMap<string, PanelRunViewModelSource> | undefined,
): PanelJobViewModel[] {
  return buildPanelViewModel(getActiveJobs(jobs), runs ?? new Map(), { maxTrackBlocks: MAX_EXPANDED_STREAM_LINES });
}

function getActiveJobs(jobs: readonly PanelJob[] | undefined): PanelJob[] {
  return (jobs ?? []).filter((job) => job.status === "active").map((job) => ({
    ...job,
    tracks: [...job.tracks],
  }));
}

function border(rt: FleetCoreRuntimeContext, theme: FleetPtyTheme | undefined, text: string): string {
  return theme?.fg("border", text) ?? `${PANEL_DIM_COLOR(rt)}${text}${ANSI_RESET}`;
}

function tileSeparator(theme: FleetPtyTheme | undefined): string {
  return ` ${theme?.fg("border", "│") ?? `\x1b[38;2;160;150;180m│${ANSI_RESET}`} `;
}

function centerLine(line: string, width: number): string {
  return truncateToWidth(" ".repeat(centerPadding(line, width)) + line, width);
}

function centerPadding(line: string, width: number): number {
  return Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
}

function formatCarrierTile(rt: FleetCoreRuntimeContext, carrier: CarrierHudTile, frame: number): string {
  const carrierColor = carrier.online ? carrier.color : DISABLED_COLOR;
  const icon = carrierStatusIcon(rt, carrier, frame, carrierColor);
  const hasActiveJob = carrier.activeJobCount > 0;
  const suffix = `${carrierBadges(rt, carrier)}${carrierActivityBadge(rt, carrier)}`;
  const prefix = `${icon} `;

  if (hasActiveJob && carrier.online) {
    return `${prefix}${waveText(carrier.displayName, carrier.rgb, frame)}${suffix}${ANSI_RESET}`;
  }

  return `${prefix}${carrierColor}${carrier.displayName}${suffix}${ANSI_RESET}`;
}

function carrierStatusIcon(rt: FleetCoreRuntimeContext, carrier: CarrierHudTile, frame: number, color?: string): string {
  if (!carrier.online) return `${DISABLED_COLOR}○${ANSI_RESET}`;
  if (carrier.activeJobCount > 0) {
    const frames = SPINNER_FRAMES(rt);
    const spinner = frames[frame % frames.length] ?? "○";
    return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
  }
  return color ? `${color}○${ANSI_RESET}` : "○";
}

function carrierBadges(rt: FleetCoreRuntimeContext, carrier: CarrierHudTile): string {
  const disabledColor = carrier.online ? null : DISABLED_COLOR;
  const tfBadgeColor = disabledColor ?? TASKFORCE_BADGE_COLOR(rt);
  const tfBadge = carrier.taskForceBackendCount >= 2
    ? ` ${tfBadgeColor}[TF:${carrier.taskForceBackendCount}]${ANSI_RESET}`
    : "";
  return tfBadge;
}

function carrierActivityBadge(rt: FleetCoreRuntimeContext, carrier: CarrierHudTile): string {
  if (carrier.activeJobCount <= 0) return "";
  const trackSuffix = carrier.activeTrackCount > 0 ? `:${carrier.activeTrackCount}` : "";
  return ` ${PANEL_DIM_COLOR(rt)}[${carrier.activeJobCount}${trackSuffix}]${ANSI_RESET}`;
}

function kindDisplayName(kind: string): string {
  return KIND_LABELS[kind] ?? capitalize(kind);
}

function capitalize(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function jobIcon(rt: FleetCoreRuntimeContext, job: PanelJobViewModel, frame: number): string {
  if (job.status === "active") {
    const color = resolveCarrierColor(rt, job.ownerCarrierId);
    const frames = SPINNER_FRAMES(rt);
    const spinner = frames[frame % frames.length] ?? "○";
    return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
  }
  if (job.status === "done") return `${COLOR_DONE}${SYM_INDICATOR(rt)}${ANSI_RESET}`;
  if (job.status === "error" || job.status === "aborted") return `${COLOR_ERROR}${SYM_INDICATOR(rt)}${ANSI_RESET}`;
  return `${PANEL_DIM_COLOR(rt)}○${ANSI_RESET}`;
}

function groupIcon(rt: FleetCoreRuntimeContext, group: CarrierJobGroupViewModel, frame: number): string {
  if (group.status === "active") {
    const color = resolveCarrierColor(rt, group.carrierId);
    const frames = SPINNER_FRAMES(rt);
    const spinner = frames[frame % frames.length] ?? "○";
    return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
  }
  if (group.status === "done") return `${COLOR_DONE}${SYM_INDICATOR(rt)}${ANSI_RESET}`;
  if (group.status === "error" || group.status === "aborted") return `${COLOR_ERROR}${SYM_INDICATOR(rt)}${ANSI_RESET}`;
  return `${PANEL_DIM_COLOR(rt)}○${ANSI_RESET}`;
}

function jobDisplayLabel(job: PanelJobViewModel): string {
  return job.kind === "carrier" ? job.label : `${kindDisplayName(job.kind)} · ${job.label}`;
}

function shouldInlineSingleTrack(job: PanelJobViewModel): boolean {
  return job.kind === "carrier" && job.tracks.length === 1;
}

function trackStatusIcon(rt: FleetCoreRuntimeContext, track: PanelTrackViewModel, frame: number, color?: string): string {
  if (track.isComplete) {
    if (track.status === "err") return `${COLOR_ERROR}${SYM_INDICATOR(rt)}${ANSI_RESET}`;
    return `${COLOR_DONE}${SYM_INDICATOR(rt)}${ANSI_RESET}`;
  }
  const frames = SPINNER_FRAMES(rt);
  const spinner = frames[frame % frames.length] ?? "○";
  return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
}

function trackDisplayName(rt: FleetCoreRuntimeContext, track: PanelTrackViewModel): string {
  if (track.kind === "backend") {
    return CLI_DISPLAY_NAMES(rt)[track.displayCli] ?? capitalize(track.displayCli);
  }
  return track.displayName;
}

function trackInlineBlock(rt: FleetCoreRuntimeContext, track: PanelTrackViewModel): string {
  if (track.blocks.length === 0) return "";
  const rendered = renderBlockLines(rt, track.blocks).filter((line) => line.text.trim());
  const latest = rendered[rendered.length - 1];
  if (!latest) return "";
  return ` ${PANEL_DIM_COLOR(rt)}·${ANSI_RESET} ${STREAM_INLINE_COLOR}${latest.text.trim()}${ANSI_RESET}`;
}

function widgetTrackStats(rt: FleetCoreRuntimeContext, track: PanelTrackViewModel): string {
  const parts: string[] = [];
  if (track.toolCallCount > 0) parts.push(`${track.toolCallCount}T`);
  if (track.textLineCount > 0) parts.push(`${track.textLineCount}L`);
  return parts.length > 0 ? ` ${PANEL_DIM_COLOR(rt)}[${parts.join("·")}]${ANSI_RESET}` : "";
}
