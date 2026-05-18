import type { Component, TerminalSize } from "../types.js";

const FLEET_PTY_ROWS = 3;
const MIN_DEDICATED_ROWS = 5;

export interface SplitPaneLayout {
  readonly dedicatedRows: number;
  readonly fleetRows: number;
}

export function computeVerticalSplit(size: TerminalSize): SplitPaneLayout {
  const fleetRows = Math.min(FLEET_PTY_ROWS, Math.max(0, size.rows - MIN_DEDICATED_ROWS));
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

