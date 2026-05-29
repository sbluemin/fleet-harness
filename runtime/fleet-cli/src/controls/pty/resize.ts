import { getTerminalSize } from "@dotobokuri/fleet-tui/core";
import type { TerminalSize } from "@dotobokuri/fleet-tui/core";
import { computeVerticalSplit } from "@dotobokuri/fleet-tui/layout";

import type { ResizeReason, ResizeRequest, TuiPtyManager, TuiPtyManagerOptions } from "../types.js";

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
      currentRequest = computeResizeRequest(options, size, reason);
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

function computeResizeRequest(options: TuiPtyManagerOptions, size: TerminalSize, reason: ResizeReason): ResizeRequest {
  const desiredFleetRows = options.fleetPty.getDesiredHeight(size.rows);
  const split = computeVerticalSplit(size, desiredFleetRows);
  return {
    columns: size.columns,
    dedicatedRows: split.dedicatedRows,
    fleetRows: split.fleetRows,
    reason,
    totalRows: size.rows,
  };
}
