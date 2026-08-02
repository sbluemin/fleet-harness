import type { TerminalSize } from "./types.js";

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
const MIN_DEDICATED_ROWS = 5;

export function computeVerticalSplit(size: TerminalSize, desiredFleetRows?: number): SplitPaneLayout {
  const maxFleetRows = Math.max(0, size.rows - MIN_DEDICATED_ROWS);
  const requestedFleetRows = desiredFleetRows ?? FLEET_PTY_ROWS;
  const fleetRows = clampRows(requestedFleetRows, 0, maxFleetRows);
  return {
    dedicatedRows: Math.max(MIN_DEDICATED_ROWS, size.rows - fleetRows),
    fleetRows,
  };
}

function clampRows(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export function getTerminalSize(): TerminalSize {
  return {
    columns: process.stdout.columns ?? DEFAULT_COLUMNS,
    rows: process.stdout.rows ?? DEFAULT_ROWS,
  };
}
