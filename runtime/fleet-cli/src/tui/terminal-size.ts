import type { TerminalSize } from "./types.js";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export function getTerminalSize(): TerminalSize {
  return {
    columns: process.stdout.columns ?? DEFAULT_COLUMNS,
    rows: process.stdout.rows ?? DEFAULT_ROWS,
  };
}
