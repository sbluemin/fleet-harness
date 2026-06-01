import {
  SUBAGENT_CARRIER_COLOR,
  SUBAGENT_CARRIER_RGB,
  getCarrierConfig,
  getRegisteredOrder,
  readCarrierAgentModeSnapshot,
  resolveAgentCliType,
  type CarrierModelDefaults,
  type CarrierRuntime,
} from "@dotobokuri/fleet-carriers";
import { truncateToWidth, visibleWidth, type FleetPtyTheme, type KeyboardProtocolState } from "../controls/index.js";

import {
  resolveCarrierColor,
  resolveCarrierDisplayName,
  resolveCarrierRgb,
} from "./carrier-helpers.js";
import {
  ANSI_RESET,
  CLI_DISPLAY_NAMES,
  getConfiguredTaskForceBackendsFromSnapshot,
  PANEL_DIM_COLOR,
  readCarriersSnapshot,
  SPINNER_FRAMES,
  SYM_INDICATOR,
  SYM_THINKING,
  TASKFORCE_BADGE_COLOR,
} from "./facade.js";
import type { CarrierJobGroupViewModel, ColBlock, PanelJob, PanelJobViewModel, PanelRunViewModelSource, PanelTrackViewModel } from "./job-bar-view-model.js";
import { buildCarrierJobGroups, buildPanelViewModel } from "./job-bar-view-model.js";

export interface CarrierHudTile {
  readonly activeJobCount: number;
  readonly activeTrackCount: number;
  readonly carrierId: string;
  readonly color: string;
  readonly displayName: string;
  readonly rgb: [number, number, number];
  readonly taskForceBackendCount: number;
}

export interface CarrierJobHudRenderOptions {
  readonly carrierRuntime: CarrierRuntime;
  readonly frame: number;
  readonly jobs?: readonly PanelJob[];
  readonly keyboardProtocol?: KeyboardProtocolState;
  readonly pendingExitWarning?: boolean;
  readonly runs?: ReadonlyMap<string, PanelRunViewModelSource>;
  readonly theme?: FleetPtyTheme;
  readonly width: number;
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
const STREAM_PREFIX = "  ";
const STREAM_INLINE_COLOR = "\x1b[38;2;100;210;245m";
const HUD_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const HUD_LINE_BREAKS = /[\r\n]+/g;
const HUD_MULTILINE_CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const DEFAULT_SAFE_LABEL = "(unnamed)";
const EXIT_WARNING_TEXT = "Press Ctrl+C again to exit";
const KIND_LABELS: Record<string, string> = {
  carrier: "Carrier",
  sortie: "Sortie",
  taskforce: "Taskforce",
};

export function renderCarrierJobHud(options: CarrierJobHudRenderOptions): string[] {
  const lines: string[] = [];
  const jobs = buildActiveJobViewModels(options.jobs, options.runs);

  if (jobs.length === 0) return [];

  appendWidgetJobSummary(options.carrierRuntime, lines, options.width, jobs, options.frame, options.theme);
  return lines.slice(0, MAX_WIDGET_LINES).map((line) => truncateToWidth(line, options.width));
}

export function renderCarrierJobHudStrip(options: CarrierJobHudRenderOptions): string[] {
  const carriers = buildCarrierTiles(options.carrierRuntime, getActiveJobs(options.jobs));
  if (carriers.length === 0 && options.pendingExitWarning !== true) return [];
  return renderCarrierHudStrip(
    options.width,
    carriers,
    options.frame,
    options.theme,
    options.keyboardProtocol,
    options.pendingExitWarning === true,
  );
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

export function renderBlockLines(blocks: readonly ColBlock[]): BlockLine[] {
  const lines: BlockLine[] = [];

  for (const block of blocks) {
    if (block.type === "thought") {
      const trimmed = sanitizeHudMultilineText(block.text);
      if (!trimmed) continue;
      trimmed.split("\n").forEach((line, i) => {
        lines.push({
          text: i === 0 ? `${SYM_THINKING()} ${line}` : `  ${line}`,
          type: "thought",
        });
      });
      continue;
    }

    if (block.type === "text") {
      const trimmed = sanitizeHudMultilineText(block.text);
      if (!trimmed) continue;
      trimmed.split("\n").forEach((line, i) => {
        lines.push({
          text: i === 0 ? `${SYM_INDICATOR()} ${line}` : `  ${line}`,
          type: "text",
        });
      });
      continue;
    }

    const isError = block.status === "failed" || block.status === "error";
    const isFinished = block.status === "completed" || block.status === "failed" || block.status === "error";
    const line: BlockLine = {
      text: `${SYM_INDICATOR()} ${sanitizeHudInlineText(block.title, DEFAULT_SAFE_LABEL)}`,
      type: isError ? "tool-error" : "tool-title",
    };
    if (isFinished) {
      lines.push({
        ...line,
        suffix: ` ${sanitizeHudInlineText(block.status)}`,
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
  theme: FleetPtyTheme | undefined,
  keyboardProtocol: KeyboardProtocolState | undefined,
  pendingExitWarning: boolean,
): string[] {
  const tiles = carriers.map((carrier) => formatCarrierTile(carrier, frame));
  const line = centerLine(tiles.join(tileSeparator(theme)), width);
  const warnedLine = prependExitWarning(line, width, pendingExitWarning);
  return [appendProtocolIndicator(warnedLine, width, keyboardProtocol)];
}

function appendWidgetJobSummary(
  carrierRuntime: CarrierRuntime,
  lines: string[],
  width: number,
  jobs: PanelJobViewModel[],
  frame: number,
  theme: FleetPtyTheme | undefined,
): void {
  const subagentModes = readCarrierAgentModeSnapshot(buildCarrierDefaults(carrierRuntime)).agentModes;
  const groups = buildCarrierJobGroups(
    jobs,
    getRegisteredOrder(carrierRuntime.registry),
    (carrierId) => resolveCarrierDisplayName(carrierRuntime.registry, carrierId),
  );
  for (let groupIndex = 0; groupIndex < groups.length && lines.length < MAX_WIDGET_LINES; groupIndex++) {
    const group = groups[groupIndex];
    if (!group || group.jobs.length === 0) continue;
    const groupColor = resolveJobBarCarrierColor(carrierRuntime, group.carrierId, subagentModes);
    lines.push(truncateToWidth(
      `${STREAM_PREFIX}${groupColor}Carrier ${group.displayName}${ANSI_RESET}`,
      width,
    ));

    for (let jobIndex = 0; jobIndex < group.jobs.length && lines.length < MAX_WIDGET_LINES; jobIndex++) {
      const job = group.jobs[jobIndex];
      if (!job) continue;
      const isLastJob = jobIndex === group.jobs.length - 1;
      const jobBranch = isLastJob ? "└─" : "├─";
      const jobColor = resolveJobBarCarrierColor(carrierRuntime, job.ownerCarrierId, subagentModes);
      const inline = shouldInlineSingleTrack(job) && job.tracks[0] && !job.tracks[0].isComplete
        ? trackInlineBlock(job.tracks[0])
        : "";
      const stats = shouldInlineSingleTrack(job) && job.tracks[0] ? widgetTrackStats(job.tracks[0]) : "";
      lines.push(truncateToWidth(
        `${STREAM_PREFIX}  ${border(theme, jobBranch)} ${jobIcon(job, frame, jobColor)} ${jobColor}${jobDisplayLabel(job)}${ANSI_RESET}${stats}${inline}`,
        width,
      ));

      if (shouldInlineSingleTrack(job)) continue;
      appendTrackRows(carrierRuntime, lines, width, job, jobColor, frame, theme, subagentModes);
    }
  }
}

function appendTrackRows(
  carrierRuntime: CarrierRuntime,
  lines: string[],
  width: number,
  job: PanelJobViewModel,
  jobColor: string,
  frame: number,
  theme: FleetPtyTheme | undefined,
  subagentModes: Record<string, "subagent">,
): void {
  for (let trackIndex = 0; trackIndex < job.tracks.length && lines.length < MAX_WIDGET_LINES; trackIndex++) {
    const track = job.tracks[trackIndex];
    if (!track) continue;
    const trackColor = resolveJobBarCarrierColor(carrierRuntime, track.displayCli, subagentModes) || jobColor;
    const icon = trackStatusIcon(track, frame, trackColor);
    const stats = widgetTrackStats(track);
    const inline = !track.isComplete ? trackInlineBlock(track) : "";
    lines.push(truncateToWidth(
      `${STREAM_PREFIX}    ${border(theme, "└─")} ${icon} ${trackColor}${trackDisplayName(track)}${ANSI_RESET}${stats}${inline}`,
      width,
    ));
  }
}

function buildCarrierTiles(carrierRuntime: CarrierRuntime, activeJobs: readonly PanelJob[]): CarrierHudTile[] {
  const snapshot = readCarriersSnapshot();
  const subagentModes = readCarrierAgentModeSnapshot(buildCarrierDefaults(carrierRuntime)).agentModes;
  return getRegisteredOrder(carrierRuntime.registry).map((carrierId) => {
    const activeCarrierJobs = activeJobs.filter((job) => job.ownerCarrierId === carrierId);
    return {
      activeJobCount: activeCarrierJobs.length,
      activeTrackCount: activeCarrierJobs.reduce((sum, job) => sum + job.tracks.length, 0),
      carrierId,
      color: resolveJobBarCarrierColor(carrierRuntime, carrierId, subagentModes),
      displayName: resolveCarrierDisplayName(carrierRuntime.registry, carrierId),
      rgb: resolveJobBarCarrierRgb(carrierRuntime, carrierId, subagentModes),
      taskForceBackendCount: getConfiguredTaskForceBackendsFromSnapshot(snapshot, carrierId).length,
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

function border(theme: FleetPtyTheme | undefined, text: string): string {
  return theme?.fg("border", text) ?? `${PANEL_DIM_COLOR()}${text}${ANSI_RESET}`;
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

function appendProtocolIndicator(line: string, width: number, state: KeyboardProtocolState | undefined): string {
  if (!state) return line;
  const indicator = formatProtocolIndicator(state);
  const indicatorWidth = visibleWidth(indicator);
  const content = truncateToWidth(line, Math.max(0, width - indicatorWidth));
  const padding = Math.max(0, width - visibleWidth(content) - indicatorWidth);
  return truncateToWidth(`${content}${" ".repeat(padding)}${indicator}`, width);
}

function prependExitWarning(line: string, width: number, pending: boolean): string {
  if (!pending) return line;
  const warning = formatExitWarning();
  const warningWidth = visibleWidth(warning);
  const trimmed = line.trimStart();
  const leftPadding = visibleWidth(line) - visibleWidth(trimmed);

  // 좌측 패딩이 경고 + 1칸 간격을 수용할 수 있으면 패딩 자리에 경고를 덮어써서
  // 캐리어 로스터의 중앙정렬 상태를 유지한다.
  if (leftPadding >= warningWidth + 1) {
    const remainingPad = leftPadding - warningWidth;
    return truncateToWidth(`${warning}${" ".repeat(remainingPad)}${trimmed}`, width);
  }

  // 좌측 패딩이 부족한 극단적 경우(로스터가 폭의 대부분을 차지)에만
  // 기존처럼 좌측 정렬 fallback으로 경고와 로스터를 모두 노출한다.
  const gapWidth = warningWidth < width ? 1 : 0;
  const contentWidth = Math.max(0, width - warningWidth - gapWidth);
  const content = truncateToWidth(trimmed, contentWidth);
  const gap = gapWidth === 1 && visibleWidth(content) > 0 ? " " : "";
  return truncateToWidth(`${warning}${gap}${content}`, width);
}

function formatExitWarning(): string {
  return `${PANEL_DIM_COLOR()}${EXIT_WARNING_TEXT}${ANSI_RESET}`;
}

function formatProtocolIndicator(state: KeyboardProtocolState): string {
  const suffix = protocolIndicatorSuffix(state);
  return `${PANEL_DIM_COLOR()}⌨${suffix}${ANSI_RESET}`;
}

function protocolIndicatorSuffix(state: KeyboardProtocolState): string {
  if (!state.outerEnabled) return "S";
  return state.effectiveMode === "transform" ? "T" : "E";
}

function formatCarrierTile(carrier: CarrierHudTile, frame: number): string {
  const icon = carrierStatusIcon(carrier, frame, carrier.color);
  const hasActiveJob = carrier.activeJobCount > 0;
  const suffix = `${carrierBadges(carrier)}${carrierActivityBadge(carrier)}`;
  const prefix = `${icon} `;

  if (hasActiveJob) {
    return `${prefix}${waveText(carrier.displayName, carrier.rgb, frame)}${suffix}${ANSI_RESET}`;
  }

  return `${prefix}${carrier.color}${carrier.displayName}${suffix}${ANSI_RESET}`;
}

function carrierStatusIcon(carrier: CarrierHudTile, frame: number, color?: string): string {
  if (carrier.activeJobCount > 0) {
    const frames = SPINNER_FRAMES();
    const spinner = frames[frame % frames.length] ?? "○";
    return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
  }
  return color ? `${color}○${ANSI_RESET}` : "○";
}

function carrierBadges(carrier: CarrierHudTile): string {
  const tfBadge = carrier.taskForceBackendCount >= 2
    ? ` ${TASKFORCE_BADGE_COLOR()}[TF:${carrier.taskForceBackendCount}]${ANSI_RESET}`
    : "";
  return tfBadge;
}

function carrierActivityBadge(carrier: CarrierHudTile): string {
  if (carrier.activeJobCount <= 0) return "";
  const trackSuffix = carrier.activeTrackCount > 0 ? `:${carrier.activeTrackCount}` : "";
  return ` ${PANEL_DIM_COLOR()}[${carrier.activeJobCount}${trackSuffix}]${ANSI_RESET}`;
}

function kindDisplayName(kind: string): string {
  return KIND_LABELS[kind] ?? capitalize(kind);
}

function capitalize(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function jobIcon(job: PanelJobViewModel, frame: number, color: string): string {
  if (job.status === "active") {
    const frames = SPINNER_FRAMES();
    const spinner = frames[frame % frames.length] ?? "○";
    return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
  }
  if (job.status === "done") return `${COLOR_DONE}${SYM_INDICATOR()}${ANSI_RESET}`;
  if (job.status === "error" || job.status === "aborted") return `${COLOR_ERROR}${SYM_INDICATOR()}${ANSI_RESET}`;
  return `${PANEL_DIM_COLOR()}○${ANSI_RESET}`;
}

function jobDisplayLabel(job: PanelJobViewModel): string {
  const label = sanitizeHudInlineText(job.label, DEFAULT_SAFE_LABEL);
  return job.kind === "carrier" ? label : `${kindDisplayName(job.kind)} · ${label}`;
}

function shouldInlineSingleTrack(job: PanelJobViewModel): boolean {
  return job.kind === "carrier" && job.tracks.length === 1;
}

function buildCarrierDefaults(carrierRuntime: CarrierRuntime): Record<string, CarrierModelDefaults> {
  return Object.fromEntries(
    getRegisteredOrder(carrierRuntime.registry)
      .map((carrierId) => {
        const config = getCarrierConfig(carrierRuntime.registry, carrierId);
        if (!config) return null;
        return [carrierId, {
          cliType: resolveAgentCliType(carrierId, config.defaultCliType),
          ...(config.defaultAgentMode ? { defaultAgentMode: config.defaultAgentMode } : {}),
          ...(config.defaultEffort ? { defaultEffort: config.defaultEffort } : {}),
          ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
        }];
      })
      .filter((entry): entry is [string, CarrierModelDefaults] => entry !== null),
  );
}

function resolveJobBarCarrierColor(
  carrierRuntime: CarrierRuntime,
  carrierId: string,
  subagentModes: Record<string, "subagent">,
): string {
  if (subagentModes[carrierId] === "subagent") return SUBAGENT_CARRIER_COLOR;
  return resolveCarrierColor(carrierRuntime.registry, carrierId);
}

function resolveJobBarCarrierRgb(
  carrierRuntime: CarrierRuntime,
  carrierId: string,
  subagentModes: Record<string, "subagent">,
): [number, number, number] {
  if (subagentModes[carrierId] === "subagent") {
    return SUBAGENT_CARRIER_RGB;
  }
  return resolveCarrierRgb(carrierRuntime.registry, carrierId);
}

function trackStatusIcon(track: PanelTrackViewModel, frame: number, color?: string): string {
  if (track.isComplete) {
    if (track.status === "err") return `${COLOR_ERROR}${SYM_INDICATOR()}${ANSI_RESET}`;
    return `${COLOR_DONE}${SYM_INDICATOR()}${ANSI_RESET}`;
  }
  const frames = SPINNER_FRAMES();
  const spinner = frames[frame % frames.length] ?? "○";
  return color ? `${color}${spinner}${ANSI_RESET}` : spinner;
}

function trackDisplayName(track: PanelTrackViewModel): string {
  if (track.kind === "backend") {
    return CLI_DISPLAY_NAMES()[track.displayCli] ?? capitalize(track.displayCli);
  }
  return track.displayName;
}

function trackInlineBlock(track: PanelTrackViewModel): string {
  if (track.blocks.length === 0) return "";
  const rendered = renderBlockLines(track.blocks).filter((line) => line.text.trim());
  const latest = rendered[rendered.length - 1];
  if (!latest) return "";
  return ` ${PANEL_DIM_COLOR()}·${ANSI_RESET} ${STREAM_INLINE_COLOR}${latest.text.trim()}${ANSI_RESET}`;
}

function sanitizeHudText(text: string): string {
  return stripHudTerminalControls(text).replace(HUD_LINE_BREAKS, " ").replace(HUD_CONTROL_CHARS, "").trim();
}

function sanitizeHudMultilineText(text: string): string {
  return stripHudTerminalControls(text)
    .replace(/\r\n?/g, "\n")
    .replace(HUD_MULTILINE_CONTROL_CHARS, "")
    .trim();
}

function sanitizeHudInlineText(text: string, fallback = ""): string {
  return sanitizeHudText(text).replace(/\s+/g, " ").trim() || fallback;
}

function stripHudTerminalControls(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      index = skipHudEscSequence(text, index);
      continue;
    }
    if (isHudC1Control(code)) {
      index = skipHudC1Sequence(text, index);
      continue;
    }

    result += text[index] ?? "";
    index++;
  }

  return result;
}

function skipHudEscSequence(text: string, index: number): number {
  const next = text.charCodeAt(index + 1);
  if (Number.isNaN(next)) return index + 1;

  if (next === 0x5b) return skipHudControlSequence(text, index + 2);
  if (next === 0x5d) return skipHudStringControl(text, index + 2, true);
  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    return skipHudStringControl(text, index + 2, false);
  }
  if (isHudEscIntermediate(next)) {
    let cursor = index + 1;
    while (cursor < text.length && isHudEscIntermediate(text.charCodeAt(cursor))) cursor++;
    return cursor < text.length ? cursor + 1 : cursor;
  }

  return index + 2;
}

function skipHudC1Sequence(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === 0x9b) return skipHudControlSequence(text, index + 1);
  if (code === 0x9d) return skipHudStringControl(text, index + 1, true);
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
    return skipHudStringControl(text, index + 1, false);
  }
  return index + 1;
}

function skipHudControlSequence(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) return cursor + 1;
    cursor++;
  }
  return cursor;
}

function skipHudStringControl(text: string, index: number, allowBel: boolean): number {
  let cursor = index;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (allowBel && code === 0x07) return cursor + 1;
    if (code === 0x9c) return cursor + 1;
    if (code === 0x1b && text.charCodeAt(cursor + 1) === 0x5c) return cursor + 2;
    cursor++;
  }
  return cursor;
}

function isHudC1Control(code: number): boolean {
  return code >= 0x80 && code <= 0x9f;
}

function isHudEscIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function widgetTrackStats(track: PanelTrackViewModel): string {
  const parts: string[] = [];
  if (track.toolCallCount > 0) parts.push(`${track.toolCallCount}T`);
  if (track.textLineCount > 0) parts.push(`${track.textLineCount}L`);
  return parts.length > 0 ? ` ${PANEL_DIM_COLOR()}[${parts.join("·")}]${ANSI_RESET}` : "";
}
