import type { MouseProtocolState, PtyHost } from "../types.js";
import { encodeSgrMouseInput, type InputRouterLayout, type RoutedMouseInput, type SgrMouseInput } from "./parser.js";

export interface MouseRouteOptions {
  readonly getLayout?: () => InputRouterLayout;
  readonly routeDedicatedMouse?: (event: RoutedMouseInput) => boolean;
  readonly routeFleetMouse?: (event: RoutedMouseInput) => boolean;
}

interface MissionControlPtyView {
  readonly isAlternateBufferActive: () => boolean;
  readonly scrollLines: (delta: number) => boolean;
}

const STANDARD_MOUSE_PROTOCOL_STATE: MouseProtocolState = {
  activeEncoding: "default",
  activeProtocol: "none",
  dragTrackingEnabled: false,
  mouseTrackingEnabled: false,
};
const WHEEL_SCROLL_LINES = 3;

export function createDedicatedMouseRouter(options: {
  readonly ptyHost: Pick<PtyHost, "getMouseProtocol" | "write">;
  readonly ptyView: MissionControlPtyView;
  readonly requestRender: () => void;
}): (event: RoutedMouseInput) => boolean {
  return (event) => {
    const mouseProtocol = options.ptyHost.getMouseProtocol?.() ?? STANDARD_MOUSE_PROTOCOL_STATE;
    if (mouseProtocol.mouseTrackingEnabled) {
      options.ptyHost.write(encodeSgrMouseInput(event, { column: event.localColumn, row: event.localRow }));
      return true;
    }

    if (event.wheelDirection === null) {
      return true;
    }

    if (options.ptyView.isAlternateBufferActive()) {
      options.ptyHost.write(event.wheelDirection === "up" ? "\x1b[A" : "\x1b[B");
      return true;
    }

    const delta = event.wheelDirection === "up" ? -WHEEL_SCROLL_LINES : WHEEL_SCROLL_LINES;
    if (options.ptyView.scrollLines(delta)) {
      options.requestRender();
    }
    return true;
  };
}

export function routeMouseInput(event: SgrMouseInput, options: MouseRouteOptions): boolean {
  const layoutProvider = options.getLayout;
  if (layoutProvider === undefined) {
    return false;
  }

  const layout = clampLayout(layoutProvider());
  if (event.column > layout.columns || event.row > layout.totalRows || event.row < 1 || event.column < 1) {
    return true;
  }

  if (event.row <= layout.dedicatedRows) {
    return options.routeDedicatedMouse?.({
      ...event,
      localColumn: event.column,
      localRow: event.row,
    }) ?? true;
  }

  if (event.row <= layout.dedicatedRows + layout.fleetRows) {
    return options.routeFleetMouse?.({
      ...event,
      localColumn: event.column,
      localRow: event.row - layout.dedicatedRows,
    }) ?? true;
  }

  return true;
}

function clampLayout(layout: InputRouterLayout): InputRouterLayout {
  return {
    columns: Math.max(0, Math.floor(layout.columns)),
    dedicatedRows: Math.max(0, Math.floor(layout.dedicatedRows)),
    fleetRows: Math.max(0, Math.floor(layout.fleetRows)),
    totalRows: Math.max(0, Math.floor(layout.totalRows)),
  };
}
