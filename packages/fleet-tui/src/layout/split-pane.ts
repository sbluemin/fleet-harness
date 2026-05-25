import type { Component, TerminalSize } from "../types.js";

export type DesiredHeight = number;

export type ResizeReason = "initial" | "terminal-resize" | "fleet-overlay" | "fleet-region" | "programmatic";

export interface PaneSize {
  readonly columns: number;
  readonly rows: number;
}

export interface ResizeRequest {
  readonly columns: number;
  readonly dedicatedRows: number;
  readonly fleetRows: number;
  readonly reason: ResizeReason;
  readonly totalRows: number;
}

export interface SplitPaneLayout {
  readonly dedicatedRows: number;
  readonly fleetRows: number;
}

const FLEET_PTY_ROWS = 3;
export const MIN_DEDICATED_ROWS = 5;

export function computeVerticalSplit(size: TerminalSize, desiredFleetRows?: number): SplitPaneLayout {
  const maxFleetRows = Math.max(0, size.rows - MIN_DEDICATED_ROWS);
  const requestedFleetRows = desiredFleetRows ?? FLEET_PTY_ROWS;
  const fleetRows = clampRows(requestedFleetRows, 0, maxFleetRows);
  return {
    dedicatedRows: Math.max(MIN_DEDICATED_ROWS, size.rows - fleetRows),
    fleetRows,
  };
}

export function renderVerticalSplit(dedicated: Component, fleet: readonly Component[], size: TerminalSize): string[] {
  const split = computeVerticalSplit(size);
  const dedicatedLines = dedicated.render(size.columns).slice(0, split.dedicatedRows);
  const fleetLines = fleet.flatMap((component) => component.render(size.columns)).slice(0, split.fleetRows);
  return [...fillLines(dedicatedLines, split.dedicatedRows), ...fillLines(fleetLines, split.fleetRows)].slice(0, size.rows);
}

function fillLines(lines: string[], count: number): string[] {
  return [...lines, ...Array.from({ length: Math.max(0, count - lines.length) }, () => "")];
}

function clampRows(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
}
