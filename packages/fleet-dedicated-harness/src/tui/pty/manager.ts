import { getTerminalSize } from "../core/terminal-size.js";
import { computeVerticalSplit } from "../layout/split-pane.js";
import type { TerminalSize } from "../types.js";
import type { FleetPtyApi } from "./fleet/api.js";
import type { ResizeReason, ResizeRequest } from "./types.js";
import type { PtyHost } from "./dedicated/types.js";

interface DedicatedPtyView {
  readonly maxRows: number;
  resize(cols: number, rows: number): void;
}

interface TuiPtyManagerOptions {
  readonly fleetPty: FleetPtyApi;
  readonly ptyHost: PtyHost;
  readonly ptyView: DedicatedPtyView;
  readonly refreshSize: (size: TerminalSize) => void;
  readonly requestRender: () => void;
}

export interface TuiPtyManager {
  readonly getCurrentRequest: () => ResizeRequest;
  readonly requestResize: (reason: ResizeReason, size?: TerminalSize) => ResizeRequest;
}

const DEFAULT_RESIZE_REQUEST: ResizeRequest = {
  columns: 0,
  dedicatedRows: 0,
  fleetRows: 0,
  reason: "initial",
  totalRows: 0,
};

export function createTuiPtyManager(options: TuiPtyManagerOptions): TuiPtyManager {
  let currentRequest = DEFAULT_RESIZE_REQUEST;
  let dirty = false;

  const applyResize = (reason: ResizeReason, size = getTerminalSize()): ResizeRequest => {
    if (dirty) {
      return currentRequest;
    }

    dirty = true;
    try {
      currentRequest = computeResizeRequest(options.fleetPty, size, reason);
      options.refreshSize(size);
      options.ptyView.resize(currentRequest.columns, currentRequest.dedicatedRows);
      options.ptyHost.resize(currentRequest.columns, currentRequest.dedicatedRows);
      options.requestRender();
    } finally {
      dirty = false;
    }

    return currentRequest;
  };

  return {
    getCurrentRequest: () => currentRequest,
    requestResize: applyResize,
  };
}

function computeResizeRequest(fleetPty: FleetPtyApi, size: TerminalSize, reason: ResizeReason): ResizeRequest {
  const desiredFleetRows = fleetPty.getDesiredHeight(size.rows);
  const split = computeVerticalSplit(size, desiredFleetRows);
  return {
    columns: size.columns,
    dedicatedRows: split.dedicatedRows,
    fleetRows: split.fleetRows,
    reason,
    totalRows: size.rows,
  };
}
