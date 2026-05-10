/**
 * fleet — 에이전트 패널 렌더러
 *
 * Agent Panel은 active PanelJob들을 잡 단위 칼럼으로 렌더링합니다.
 * 각 칼럼 내부는 ColumnTrack 트리 + 최근 5줄 tail 스트리밍 콘텐츠를 표시합니다.
 */

import { truncateToWidth, visibleWidth } from "@sbluemin/fleet-tui";
import type { Theme } from "@sbluemin/fleet-coding-agent";
import {
  ANSI_RESET,
  BORDER,
  PANEL_COLOR,
  PANEL_DIM_COLOR,
  SPINNER_FRAMES,
  SYM_INDICATOR,
} from "../fleet-core-facades.js";
import { buildPanelViewModel } from "./view-model.js";
import type { PanelJobViewModel, PanelTrackViewModel } from "./view-model.js";

import {
  resolveCarrierBgColor,
  resolveCarrierColor,
  resolveCarrierDisplayName,
  resolveCarrierRgb,
} from "../tools.js";
import type { PanelRun } from "./state.js";
import type { PanelJob } from "./types.js";
import type { ColStatus } from "./types.js";
import { blockLineToAnsi, renderBlockLines } from "./message-render.js";
import { waveText } from "./wave-text.js";

export { waveText } from "./wave-text.js";

const MAX_TRACK_STREAM_LINES = 5;

export function renderPanelFull(
  w: number,
  jobs: PanelJob[],
  runs: ReadonlyMap<string, PanelRun>,
  frame: number,
  frameColor: string,
  bottomHint: string,
  bodyH: number,
  cursorColumn = -1,
  theme?: Theme,
): string[] {
  const visibleJobs = buildPanelViewModel(jobs, runs, { maxTrackBlocks: MAX_TRACK_STREAM_LINES });
  const FC = frameColor || PANEL_COLOR;

  return renderMultiJobView(w, visibleJobs, frame, FC, bottomHint, bodyH, cursorColumn, theme);
}

function renderMultiJobView(
  w: number,
  jobs: PanelJobViewModel[],
  frame: number,
  FC: string,
  bottomHint: string,
  bodyH: number,
  cursorColumn: number,
  theme: Theme | undefined,
): string[] {
  if (jobs.length === 0) {
    return renderEmptyPanel(w, FC, bottomHint, bodyH, theme);
  }

  const iw = Math.max(15, w - (jobs.length + 1));
  const base = Math.floor(iw / jobs.length);
  const widths = Array.from({ length: jobs.length }, (_, index) =>
    index < jobs.length - 1 ? base : iw - base * (jobs.length - 1),
  );
  const cursorBg = cursorColumn >= 0
    ? resolveCarrierBgColor(jobs[cursorColumn]?.ownerCarrierId ?? "")
    : "";
  const applyBg = (text: string, bg: string) =>
    bg + text.replaceAll(ANSI_RESET, ANSI_RESET + bg) + ANSI_RESET;

  const rows: string[] = [];
  let ri = 0;

  rows.push(renderTopBorder(w, FC, theme));
  ri++;

  const headerCells = jobs.map((job, index) => {
    const cell = centerText(buildJobHeader(job, frame), widths[index] ?? 0);
    return index === cursorColumn && cursorBg ? applyBg(cell, cursorBg) : cell;
  });
  rows.push(joinCells(headerCells, widths, FC, theme));
  ri++;

  const sep = "├" + widths.map((width) => BORDER.horizontal.repeat(width)).join("┼") + "┤";
  rows.push(hBorder(sep, FC, theme) + ANSI_RESET);
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
    rows.push(joinCells(cells, widths, FC, theme));
    ri++;
  }

  rows.push(renderBottomBorder(w, FC, bottomHint, theme));
  return rows;
}

function renderEmptyPanel(
  w: number,
  FC: string,
  bottomHint: string,
  bodyH: number,
  theme: Theme | undefined,
): string[] {
  const rows: string[] = [];
  let ri = 0;
  const iw = Math.max(15, w - 2);

  rows.push(renderTopBorder(w, FC, theme));
  ri++;
  rows.push(vBorder(FC, theme) + ANSI_RESET + pad("", iw) + vBorder(FC, theme) + ANSI_RESET);
  ri++;
  rows.push(hBorder("├" + BORDER.horizontal.repeat(iw) + "┤", FC, theme) + ANSI_RESET);
  ri++;
  for (let row = 0; row < bodyH; row++) {
    rows.push(vBorder(FC, theme) + ANSI_RESET + pad("", iw) + vBorder(FC, theme) + ANSI_RESET);
    ri++;
  }
  rows.push(renderBottomBorder(w, FC, bottomHint, theme));
  return rows;
}

function buildJobHeader(job: PanelJobViewModel, frame: number): string {
  const color = resolveCarrierColor(job.ownerCarrierId) || PANEL_COLOR;
  const jobLabel = job.kind === "carrier"
    ? resolveCarrierDisplayName(job.ownerCarrierId)
    : job.label;
  const label = `${capitalize(job.kind)} · ${jobLabel} · ${formatElapsed((job.finishedAt ?? Date.now()) - job.startedAt)}`;
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
    const liveDisplayName = track.kind === "carrier"
      ? resolveCarrierDisplayName(track.displayCli)
      : track.displayName;
    const treePrefix = index === job.tracks.length - 1 ? "└─" : "├─";
    const connector = index === job.tracks.length - 1 ? "   " : "│  ";
    const liveStatus = track.status;
    const stats = buildTrackStats(track);
    const icon = trackIcon(liveStatus, frame, job.ownerCarrierId);
    const nameColor = track.displayCli ? (resolveCarrierColor(track.displayCli) || PANEL_COLOR) : "";
    const nameReset = nameColor ? ANSI_RESET : "";
    const doneSuffix = liveStatus === "done" ? ` ${PANEL_DIM_COLOR}✓ Done${ANSI_RESET}` : "";
    lines.push(truncateToWidth(
      `${PANEL_DIM_COLOR}${treePrefix}${ANSI_RESET} ${icon} ${nameColor}${liveDisplayName}${nameReset}${stats ? ` ${PANEL_DIM_COLOR}[${stats}]${ANSI_RESET}` : ""}${doneSuffix}`,
      contentWidth,
    ));
    lines.push(...getTrackStreamTail(track, connector, contentWidth, liveStatus));
  }
  return lines.slice(-bodyH);
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

function joinCells(
  cells: string[],
  widths: number[],
  FC: string,
  theme: Theme | undefined,
): string {
  let line = vBorder(FC, theme) + ANSI_RESET;
  for (let index = 0; index < cells.length; index++) {
    line += cells[index] ?? pad("", widths[index] ?? 0);
    line += vBorder(FC, theme) + ANSI_RESET;
  }
  return line;
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

function vBorder(FC: string, theme?: Theme): string {
  return theme?.fg("border", BORDER.vertical) ?? FC + BORDER.vertical;
}

function hBorder(text: string, FC: string, theme?: Theme): string {
  return theme?.fg("border", text) ?? FC + text;
}

function renderTopBorder(w: number, FC: string, theme: Theme | undefined): string {
  const title = " ◈ Fleet Bridge ";
  const titleWidth = visibleWidth(title);
  const fill = Math.max(0, w - 2 - titleWidth);
  const left = Math.floor(fill / 2);
  const right = fill - left;
  const full = BORDER.topLeft + BORDER.horizontal.repeat(left) + title + BORDER.horizontal.repeat(right) + BORDER.topRight;
  return hBorder(full, FC, theme) + ANSI_RESET;
}

function renderBottomBorder(
  w: number,
  FC: string,
  bottomHint: string,
  theme: Theme | undefined,
): string {
  const hintWidth = visibleWidth(bottomHint);
  const fill = Math.max(0, w - 2 - hintWidth);
  const left = Math.floor(fill / 2);
  const right = fill - left;
  const leftPart = BORDER.bottomLeft + BORDER.horizontal.repeat(left);
  const rightPart = BORDER.horizontal.repeat(right) + BORDER.bottomRight;
  return (
    hBorder(leftPart, FC, theme) + ANSI_RESET +
    PANEL_DIM_COLOR + bottomHint + ANSI_RESET +
    hBorder(rightPart, FC, theme) + ANSI_RESET
  );
}
