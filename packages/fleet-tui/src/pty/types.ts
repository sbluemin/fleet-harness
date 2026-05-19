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
