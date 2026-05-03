/**
 * fleet — 에이전트 패널 렌더러
 *
 * Agent Panel은 active PanelJob들을 잡 단위 칼럼으로 렌더링합니다.
 * 각 칼럼 내부는 ColumnTrack 트리 + 최근 5줄 tail 스트리밍 콘텐츠를 표시합니다.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
  ANSI_RESET,
  BORDER,
  PANEL_COLOR,
  PANEL_DIM_COLOR,
  PANEL_RGB,
  SPINNER_FRAMES,
  SYM_INDICATOR,
} from "../fleet-core-facades.js";
import { buildPanelViewModel } from "./view-model.js";
import type { PanelJobViewModel, PanelTrackViewModel } from "./view-model.js";

import {
  resolveCarrierBgColor,
  resolveCarrierColor,
  resolveCarrierRgb,
} from "../tools.js";
import type { PanelRun } from "./state.js";
import type { PanelJob } from "./types.js";
import type { ColStatus } from "./types.js";
import { blockLineToAnsi, renderBlockLines } from "./message-render.js";
import { waveText } from "./wave-text.js";

export { waveText } from "./wave-text.js";

interface WaveConfig {
  rgb: [number, number, number];
  frame: number;
  totalDiag: number;
  bandWidth: number;
}

const MAX_TRACK_STREAM_LINES = 5;

export function renderPanelFull(
  w: number,
  jobs: PanelJob[],
  runs: ReadonlyMap<string, PanelRun>,
  frame: number,
  frameColor: string,
  bottomHint: string,
  detailTrackId: string | null,
  bodyH: number,
  cursorColumn = -1,
): string[] {
  const visibleJobs = buildPanelViewModel(jobs, runs, { maxTrackBlocks: MAX_TRACK_STREAM_LINES });
  const detailTarget = detailTrackId ? findTrackById(visibleJobs, detailTrackId) : null;
  const panelH = 3 + bodyH + 1;
  const totalDiag = (w - 1) + (panelH - 1);
  const isStreaming = visibleJobs.some((job) => job.status === "active");
  const wave: WaveConfig | undefined = isStreaming
    ? { rgb: PANEL_RGB, frame, totalDiag, bandWidth: 12 }
    : undefined;
  const FC = frameColor || PANEL_COLOR;

  if (detailTarget) {
    return renderDetailView(w, detailTarget.job, detailTarget.track, frame, FC, bottomHint, bodyH, wave);
  }

  return renderMultiJobView(w, visibleJobs, frame, FC, bottomHint, bodyH, wave, cursorColumn);
}

function renderDetailView(
  w: number,
  job: PanelJobViewModel,
  track: PanelTrackViewModel,
  frame: number,
  FC: string,
  bottomHint: string,
  bodyH: number,
  wave: WaveConfig | undefined,
): string[] {
  const iw = Math.max(15, w - 2);
  const rows: string[] = [];
  let ri = 0;

  rows.push(renderTopBorder(w, FC, wave));
  ri++;

  rows.push(
    vBorder(FC, wave, ri) + ANSI_RESET +
    centerText(buildJobHeader(job, frame), iw) +
    vBorder(FC, wave, w - 1 + ri) + ANSI_RESET,
  );
  ri++;
  rows.push(hBorder("├" + BORDER.horizontal.repeat(iw) + "┤", FC, wave, ri) + ANSI_RESET);
  ri++;

  const content = buildTrackContent(track, bodyH, frame);
  for (let row = 0; row < bodyH; row++) {
    const line = content[row] ?? "";
    rows.push(
      vBorder(FC, wave, ri) + ANSI_RESET +
      " " + pad(line, iw - 1) +
      vBorder(FC, wave, w - 1 + ri) + ANSI_RESET,
    );
    ri++;
  }

  rows.push(renderBottomBorder(w, FC, bottomHint, wave, ri));
  return rows;
}

function renderMultiJobView(
  w: number,
  jobs: PanelJobViewModel[],
  frame: number,
  FC: string,
  bottomHint: string,
  bodyH: number,
  wave: WaveConfig | undefined,
  cursorColumn: number,
): string[] {
  if (jobs.length === 0) {
    return renderEmptyPanel(w, FC, bottomHint, bodyH, wave);
  }

  const iw = Math.max(15, w - (jobs.length + 1));
  const base = Math.floor(iw / jobs.length);
  const widths = Array.from({ length: jobs.length }, (_, index) =>
    index < jobs.length - 1 ? base : iw - base * (jobs.length - 1),
  );
  const vx: number[] = [0];
  let acc = 0;
  for (let i = 0; i < jobs.length; i++) {
    acc += widths[i] ?? 0;
    vx.push(i + 1 + acc);
  }

  const cursorBg = cursorColumn >= 0
    ? resolveCarrierBgColor(jobs[cursorColumn]?.ownerCarrierId ?? "")
    : "";
  const applyBg = (text: string, bg: string) =>
    bg + text.replaceAll(ANSI_RESET, ANSI_RESET + bg) + ANSI_RESET;

  const rows: string[] = [];
  let ri = 0;

  rows.push(renderTopBorder(w, FC, wave));
  ri++;

  const headerCells = jobs.map((job, index) => {
    const cell = centerText(buildJobHeader(job, frame), widths[index] ?? 0);
    return index === cursorColumn && cursorBg ? applyBg(cell, cursorBg) : cell;
  });
  rows.push(joinCells(headerCells, widths, vx, FC, wave, ri));
  ri++;

  const sep = "├" + widths.map((width) => BORDER.horizontal.repeat(width)).join("┼") + "┤";
  rows.push(hBorder(sep, FC, wave, ri) + ANSI_RESET);
  ri++;

  const contents = jobs.map((job, index) =>
    buildJobColumnContent(job, widths[index] ?? 0, bodyH, frame),
  );

  for (let row = 0; row < bodyH; row++) {
    const cells = contents.map((content, index) => {
      const line = content[row] ?? "";
      const cell = pad(line, widths[index] ?? 0);
      return index === cursorColumn && cursorBg ? applyBg(cell, cursorBg) : cell;
    });
    rows.push(joinCells(cells, widths, vx, FC, wave, ri));
    ri++;
  }

  rows.push(renderBottomBorder(w, FC, bottomHint, wave, ri));
  return rows;
}

function renderEmptyPanel(
  w: number,
  FC: string,
  bottomHint: string,
  bodyH: number,
  wave: WaveConfig | undefined,
): string[] {
  const rows: string[] = [];
  let ri = 0;
  const iw = Math.max(15, w - 2);

  rows.push(renderTopBorder(w, FC, wave));
  ri++;
  rows.push(vBorder(FC, wave, ri) + ANSI_RESET + pad("", iw) + vBorder(FC, wave, w - 1 + ri) + ANSI_RESET);
  ri++;
  rows.push(hBorder("├" + BORDER.horizontal.repeat(iw) + "┤", FC, wave, ri) + ANSI_RESET);
  ri++;
  for (let row = 0; row < bodyH; row++) {
    rows.push(vBorder(FC, wave, ri) + ANSI_RESET + pad("", iw) + vBorder(FC, wave, w - 1 + ri) + ANSI_RESET);
    ri++;
  }
  rows.push(renderBottomBorder(w, FC, bottomHint, wave, ri));
  return rows;
}

function buildJobHeader(job: PanelJobViewModel, frame: number): string {
  const color = resolveCarrierColor(job.ownerCarrierId) || PANEL_COLOR;
  const label = `${capitalize(job.kind)} · ${job.label} · ${formatElapsed((job.finishedAt ?? Date.now()) - job.startedAt)}`;
  if (job.status !== "active") {
    return `${color}◈ ${label}${ANSI_RESET}`;
  }
  return `${color}◈ ${waveText(label, resolveCarrierRgb(job.ownerCarrierId), frame, 0, { speed: 0.45 })}${ANSI_RESET}`;
}

function buildJobColumnContent(job: PanelJobViewModel, width: number, bodyH: number, frame: number): string[] {
  const contentWidth = Math.max(0, width);
  const lines: string[] = [];
  for (let index = 0; index < job.tracks.length; index++) {
    const track = job.tracks[index];
    const treePrefix = index === job.tracks.length - 1 ? "└─" : "├─";
    const connector = index === job.tracks.length - 1 ? "   " : "│  ";
    const liveStatus = track.status;
    const stats = buildTrackStats(track);
    const icon = trackIcon(liveStatus, frame, job.ownerCarrierId);
    const nameColor = track.displayCli ? (resolveCarrierColor(track.displayCli) || PANEL_COLOR) : "";
    const nameReset = nameColor ? ANSI_RESET : "";
    const doneSuffix = liveStatus === "done" ? ` ${PANEL_DIM_COLOR}✓ Done${ANSI_RESET}` : "";
    lines.push(truncateToWidth(
      `${PANEL_DIM_COLOR}${treePrefix}${ANSI_RESET} ${icon} ${nameColor}${track.displayName}${nameReset}${stats ? ` ${PANEL_DIM_COLOR}[${stats}]${ANSI_RESET}` : ""}${doneSuffix}`,
      contentWidth,
    ));
    lines.push(...getTrackStreamTail(track, connector, contentWidth, liveStatus));
  }
  return lines.slice(-bodyH);
}

function buildTrackContent(track: PanelTrackViewModel, bodyH: number, frame: number): string[] {
  const liveStatus = track.status;
  const stats = buildTrackStats(track);
  return [
    `${trackIcon(liveStatus, frame, track.displayCli)} ${track.displayName}${stats ? ` ${PANEL_DIM_COLOR}[${stats}]${ANSI_RESET}` : ""}${liveStatus === "done" ? ` ${PANEL_DIM_COLOR}✓ Done${ANSI_RESET}` : ""}`,
    ...getTrackStreamTail(track, "   ", Number.MAX_SAFE_INTEGER, liveStatus),
  ].slice(-bodyH);
}

function getTrackStreamTail(track: PanelTrackViewModel, connector: string, width: number, liveStatus?: ColStatus): string[] {
  const effectiveStatus = liveStatus ?? track.status;
  const prefix = `${PANEL_DIM_COLOR}${connector}${ANSI_RESET}   `;
  if (effectiveStatus === "done") return [];
  if (track.blocks.length === 0) return [];
  const blockLines = renderBlockLines(track.blocks).filter((line) => line.text.trim());
  const tail = blockLines.slice(-MAX_TRACK_STREAM_LINES);
  return tail.map((line) => truncateToWidth(`${prefix}${blockLineToAnsi(line)}`, width));
}

function buildTrackStats(track: PanelTrackViewModel): string {
  if (track.toolCallCount === 0 && track.textLineCount === 0) return "";
  const parts: string[] = [];
  if (track.toolCallCount > 0) parts.push(`${track.toolCallCount}T`);
  if (track.textLineCount > 0) parts.push(`${track.textLineCount}L`);
  return parts.join("·");
}

function trackIcon(status: ColStatus, frame: number, carrierId: string): string {
  if (status === "wait") return `${PANEL_DIM_COLOR}○${ANSI_RESET}`;
  if (status === "conn" || status === "stream") {
    return `${resolveCarrierColor(carrierId) || PANEL_COLOR}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${ANSI_RESET}`;
  }
  if (status === "done") return `\x1b[38;2;100;200;100m${SYM_INDICATOR}${ANSI_RESET}`;
  return `\x1b[38;2;255;80;80m${SYM_INDICATOR}${ANSI_RESET}`;
}

function joinCells(cells: string[], widths: number[], vx: number[], FC: string, wave: WaveConfig | undefined, row: number): string {
  let line = vBorder(FC, wave, vx[0] + row) + ANSI_RESET;
  for (let index = 0; index < cells.length; index++) {
    line += cells[index] ?? pad("", widths[index] ?? 0);
    line += vBorder(FC, wave, vx[index + 1] + row) + ANSI_RESET;
  }
  return line;
}

function findTrackById(jobs: PanelJobViewModel[], trackId: string): { job: PanelJobViewModel; track: PanelTrackViewModel } | null {
  for (const job of jobs) {
    const track = job.tracks.find((item) => item.trackId === trackId);
    if (track) return { job, track };
  }
  return null;
}

function capitalize(text: string): string {
  return text.length > 0 ? `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}` : text;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}:${String(sec).padStart(2, "0")}`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}:${String(remMin).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function centerText(text: string, width: number): string {
  const fitted = visibleWidth(text) > width ? truncateToWidth(text, width) : text;
  const remaining = Math.max(0, width - visibleWidth(fitted));
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return " ".repeat(left) + fitted + " ".repeat(right);
}

function vBorder(FC: string, wave: WaveConfig | undefined, diag: number): string {
  if (wave) return sweepColorChar(BORDER.vertical, wave.rgb, sweepFactor(diag, wave));
  return FC + BORDER.vertical;
}

function hBorder(text: string, FC: string, wave: WaveConfig | undefined, row: number, startX = 0): string {
  if (wave) {
    let result = "";
    let x = startX;
    for (const ch of text) {
      result += sweepColorChar(ch, wave.rgb, sweepFactor(x + row, wave));
      x++;
    }
    return result;
  }
  return FC + text;
}

function renderTopBorder(w: number, FC: string, wave?: WaveConfig): string {
  const title = " ◈ Fleet Bridge ";
  const titleWidth = visibleWidth(title);
  const fill = Math.max(0, w - 2 - titleWidth);
  const left = Math.floor(fill / 2);
  const right = fill - left;
  const full = BORDER.topLeft + BORDER.horizontal.repeat(left) + title + BORDER.horizontal.repeat(right) + BORDER.topRight;
  return hBorder(full, FC, wave, 0) + ANSI_RESET;
}

function renderBottomBorder(w: number, FC: string, bottomHint: string, wave: WaveConfig | undefined, row: number): string {
  const hintWidth = visibleWidth(bottomHint);
  const fill = Math.max(0, w - 2 - hintWidth);
  const left = Math.floor(fill / 2);
  const right = fill - left;
  const leftPart = BORDER.bottomLeft + BORDER.horizontal.repeat(left);
  const rightPart = BORDER.horizontal.repeat(right) + BORDER.bottomRight;
  const rightStartX = visibleWidth(leftPart) + hintWidth;
  return (
    hBorder(leftPart, FC, wave, row) + ANSI_RESET +
    PANEL_DIM_COLOR + bottomHint + ANSI_RESET +
    hBorder(rightPart, FC, wave, row, rightStartX) + ANSI_RESET
  );
}

function sweepFactor(diag: number, cfg: WaveConfig): number {
  const cycle = cfg.totalDiag + cfg.bandWidth;
  const sweepPos = (cfg.frame * 4.0) % cycle - cfg.bandWidth * 0.3;
  const dist = diag - sweepPos;
  if (dist >= 0 && dist <= cfg.bandWidth) {
    const t = (dist / cfg.bandWidth - 0.5) * 3;
    return Math.exp(-t * t) * 0.5;
  }
  return -0.2;
}

function sweepColorChar(ch: string, rgb: [number, number, number], factor: number): string {
  const [r, g, b] = rgb;
  const cr = Math.min(255, Math.max(0, Math.round(
    factor >= 0 ? r + (255 - r) * factor : r + r * factor,
  )));
  const cg = Math.min(255, Math.max(0, Math.round(
    factor >= 0 ? g + (255 - g) * factor : g + g * factor,
  )));
  const cb = Math.min(255, Math.max(0, Math.round(
    factor >= 0 ? b + (255 - b) * factor : b + b * factor,
  )));
  return `\x1b[38;2;${cr};${cg};${cb}m${ch}`;
}
