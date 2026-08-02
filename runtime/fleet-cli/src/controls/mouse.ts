import type { MouseEncodingName, MouseProtocolName, MouseProtocolState, PtyHost } from "./types.js";

export type MouseWheelDirection = "up" | "down";

export interface SgrMouseInput {
  readonly buttonCode: number;
  readonly column: number;
  readonly final: "M" | "m";
  readonly raw: string;
  readonly row: number;
  readonly wheelDirection: MouseWheelDirection | null;
}

export interface InputRouterLayout {
  readonly columns: number;
  readonly dedicatedRows: number;
  readonly fleetRows: number;
  readonly totalRows: number;
}

export type RoutedMouseInput = SgrMouseInput & {
  readonly localColumn: number;
  readonly localRow: number;
};

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/;
const SGR_MOUSE_WHEEL_UP = 64;
const SGR_MOUSE_WHEEL_DOWN = 65;

export function parseSgrMouseInput(token: string): SgrMouseInput | null {
  const match = SGR_MOUSE_PATTERN.exec(token);
  if (match === null) {
    return null;
  }

  const buttonCode = Number.parseInt(match[1] ?? "", 10);
  const column = Number.parseInt(match[2] ?? "", 10);
  const row = Number.parseInt(match[3] ?? "", 10);
  const final = match[4] as "M" | "m";
  if (!isValidCoordinate(column) || !isValidCoordinate(row) || !Number.isSafeInteger(buttonCode)) {
    return null;
  }

  return {
    buttonCode,
    column,
    final,
    raw: token,
    row,
    wheelDirection: getWheelDirection(buttonCode),
  };
}

export function encodeSgrMouseInput(event: SgrMouseInput, coords?: { readonly column?: number; readonly row?: number }): string {
  const column = coords?.column ?? event.column;
  const row = coords?.row ?? event.row;
  if (!isValidCoordinate(column) || !isValidCoordinate(row)) {
    return event.raw;
  }

  return `\x1b[<${event.buttonCode};${column};${row}${event.final}`;
}

function getWheelDirection(buttonCode: number): MouseWheelDirection | null {
  if (buttonCode === SGR_MOUSE_WHEEL_UP) {
    return "up";
  }

  if (buttonCode === SGR_MOUSE_WHEEL_DOWN) {
    return "down";
  }

  return null;
}

function isValidCoordinate(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

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

export interface MouseProtocol {
  readonly detectChildRequest: (chunk: string) => void;
  readonly getState: () => MouseProtocolState;
}

interface MutableMouseProtocolState {
  activeEncodingModes: Set<number>;
  activeProtocolModes: Set<number>;
}

const PRIVATE_MODE_PATTERN = /\x1b\[\?([0-9;]+)([hl])/g;
const MOUSE_PROTOCOL_MODES = new Set([9, 1000, 1002, 1003]);
const SGR_ENCODING_MODE = 1006;
const SGR_PIXELS_ENCODING_MODE = 1016;

export function createMouseProtocol(): MouseProtocol {
  const state: MutableMouseProtocolState = {
    activeEncodingModes: new Set(),
    activeProtocolModes: new Set(),
  };

  return {
    detectChildRequest(chunk: string): void {
      detectMouseProtocolRequest(chunk, state);
    },

    getState(): MouseProtocolState {
      return toPublicState(state);
    },
  };
}

function detectMouseProtocolRequest(chunk: string, state: MutableMouseProtocolState): void {
  for (const match of chunk.matchAll(PRIVATE_MODE_PATTERN)) {
    const action = match[2];
    const modes = parseModes(match[1] ?? "");
    for (const mode of modes) {
      applyMouseMode(state, mode, action);
    }
  }
}

function applyMouseMode(state: MutableMouseProtocolState, mode: number, action: string | undefined): void {
  if (action === "h") {
    enableMouseMode(state, mode);
    return;
  }

  if (action === "l") {
    disableMouseMode(state, mode);
  }
}

function disableMouseMode(state: MutableMouseProtocolState, mode: number): void {
  if (MOUSE_PROTOCOL_MODES.has(mode)) {
    state.activeProtocolModes.delete(mode);
    return;
  }

  if (mode === SGR_ENCODING_MODE || mode === SGR_PIXELS_ENCODING_MODE) {
    state.activeEncodingModes.delete(mode);
  }
}

function enableMouseMode(state: MutableMouseProtocolState, mode: number): void {
  if (MOUSE_PROTOCOL_MODES.has(mode)) {
    state.activeProtocolModes.add(mode);
    return;
  }

  if (mode === SGR_ENCODING_MODE || mode === SGR_PIXELS_ENCODING_MODE) {
    state.activeEncodingModes.add(mode);
  }
}

function getActiveEncoding(state: MutableMouseProtocolState): MouseEncodingName {
  if (state.activeEncodingModes.has(SGR_ENCODING_MODE)) {
    return "sgr";
  }

  if (state.activeEncodingModes.has(SGR_PIXELS_ENCODING_MODE)) {
    return "sgr-pixels";
  }

  return "default";
}

function getActiveProtocol(state: MutableMouseProtocolState): MouseProtocolName {
  if (state.activeProtocolModes.has(1003)) {
    return "any";
  }

  if (state.activeProtocolModes.has(1002)) {
    return "drag";
  }

  if (state.activeProtocolModes.has(1000)) {
    return "vt200";
  }

  if (state.activeProtocolModes.has(9)) {
    return "x10";
  }

  return "none";
}

function hasActiveDragProtocol(state: MutableMouseProtocolState): boolean {
  return state.activeProtocolModes.has(1002) || state.activeProtocolModes.has(1003);
}

function hasActiveWheelProtocol(state: MutableMouseProtocolState): boolean {
  return state.activeProtocolModes.has(1000) || hasActiveDragProtocol(state);
}

function parseModes(rawModes: string): number[] {
  return rawModes
    .split(";")
    .map((mode) => Number.parseInt(mode, 10))
    .filter((mode) => Number.isSafeInteger(mode));
}

function toPublicState(state: MutableMouseProtocolState): MouseProtocolState {
  const activeEncoding = getActiveEncoding(state);

  return {
    activeEncoding,
    activeProtocol: getActiveProtocol(state),
    dragTrackingEnabled: hasActiveDragProtocol(state) && state.activeEncodingModes.has(SGR_ENCODING_MODE),
    mouseTrackingEnabled: hasActiveWheelProtocol(state) && state.activeEncodingModes.has(SGR_ENCODING_MODE),
  };
}
