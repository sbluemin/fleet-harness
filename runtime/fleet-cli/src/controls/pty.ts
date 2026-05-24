import { getTerminalSize } from "@dotobokuri/fleet-tui/core";
import type { TerminalSize } from "@dotobokuri/fleet-tui/core";
import { computeVerticalSplit } from "@dotobokuri/fleet-tui/layout";
import { spawn, type IPty } from "node-pty";

import type {
  KeyboardProtocolState,
  MouseEncodingName,
  MouseProtocolName,
  MouseProtocolState,
  PtyExitEvent,
  PtyHost,
  PtyLaunchConfig,
  PtyStartOptions,
  ResizeReason,
  ResizeRequest,
  TuiPtyManager,
  TuiPtyManagerOptions,
} from "./types.js";

export interface KeyboardProtocol {
  detectChildRequest(chunk: string): void;
  getState(): KeyboardProtocolState;
  transformInput(data: string): string;
}

export interface CsiUInputNormalizer {
  readonly normalize: (data: string) => string;
}

export interface CreateCsiUInputNormalizerDeps {
  readonly csiUMap: ReadonlyMap<string, string>;
}

interface CreatePtyHostDeps {
  readonly startShell?: ShellStarter;
}

interface MouseProtocol {
  readonly detectChildRequest: (chunk: string) => void;
  readonly getState: () => MouseProtocolState;
}

interface MutableMouseProtocolState {
  activeEncoding: MouseEncodingName;
  activeProtocol: MouseProtocolName;
}

export type ShellStarter = (config: PtyLaunchConfig, opts: PtyStartOptions) => IPty;

export const KITTY_ENABLE = "\x1b[>4;2m\x1b[>1u";
export const KITTY_DISABLE = "\x1b[<u\x1b[>4;0m";
export const KITTY_ENABLE_REGEX = /\x1b\[>(?:\d+u|4;\d+m)/;

const SHIFT_ENTER_CSI_U = "\x1b[13;2u";
const BASIC_SHIFT_ENTER = "\n";
const PRIVATE_MODE_PATTERN = /\x1b\[\?([0-9;]+)([hl])/g;
const MOUSE_PROTOCOL_MODES = new Set([9, 1000, 1002, 1003]);
const SGR_ENCODING_MODE = 1006;
const SGR_PIXELS_ENCODING_MODE = 1016;
const DEFAULT_RESIZE_REQUEST: ResizeRequest = {
  columns: 0,
  dedicatedRows: 0,
  fleetRows: 0,
  reason: "initial",
  totalRows: 0,
};

export function createPtyHost(config: PtyLaunchConfig, deps: CreatePtyHostDeps = {}): PtyHost {
  let child: IPty | undefined;
  let started = false;
  const handlers: Array<(chunk: string) => void> = [];
  const exitHandlers: Array<(event: PtyExitEvent) => void> = [];
  const protocol = createKeyboardProtocol();
  const mouseProtocol = createMouseProtocol();
  const startShellFn = deps.startShell ?? startShell;

  return {
    start(opts: PtyStartOptions): void {
      if (started) {
        return;
      }

      started = true;
      child = startShellFn(config, opts);

      child.onData((chunk) => {
        protocol.detectChildRequest(chunk);
        mouseProtocol.detectChildRequest(chunk);
        for (const handler of handlers) {
          handler(chunk);
        }
      });

      let exitNotified = false;
      child.onExit((event) => {
        if (exitNotified) {
          return;
        }

        exitNotified = true;
        child = undefined;
        const exitEvent = normalizeExitEvent(event);
        for (const handler of exitHandlers) {
          handler(exitEvent);
        }
      });
    },

    write(data: string): void {
      child?.write(encodeTerminalInput(data, protocol));
    },

    resize(cols: number, rows: number): void {
      resizeShell(child, cols, rows);
    },

    onData(handler: (chunk: string) => void): void {
      handlers.push(handler);
    },

    onExit(handler: (event: PtyExitEvent) => void): void {
      exitHandlers.push(handler);
    },

    getKeyboardProtocol(): KeyboardProtocolState {
      return protocol.getState();
    },

    getMouseProtocol() {
      return mouseProtocol.getState();
    },

    kill(): void {
      killShell(child);
      child = undefined;
    },
  };
}

export function startShell(config: PtyLaunchConfig, opts: PtyStartOptions): IPty {
  return spawn(config.profile.bin, [...config.profile.args], {
    cols: opts.cols,
    cwd: config.profile.cwd,
    env: config.profile.env,
    name: config.profile.terminalName,
    rows: opts.rows,
  });
}

export function resizeShell(child: IPty | undefined, cols: number, rows: number): void {
  child?.resize(cols, rows);
}

export function killShell(child: IPty | undefined): void {
  child?.kill();
}

export function encodeTerminalInput(data: string, protocol?: KeyboardProtocol): string {
  return protocol?.transformInput(data) ?? data;
}

export function createCsiUInputNormalizer(deps: CreateCsiUInputNormalizerDeps): CsiUInputNormalizer {
  return {
    normalize(data): string {
      return normalizeCsiUInput(data, deps.csiUMap);
    },
  };
}

export function normalizeCsiUInput(data: string, csiUMap: ReadonlyMap<string, string>): string {
  let result = data;
  for (const [csiU, legacy] of csiUMap) {
    if (result.includes(csiU)) {
      result = result.replaceAll(csiU, legacy);
    }
  }
  return result;
}

export function createKeyboardProtocol(): KeyboardProtocol {
  let childRequested = false;
  const outerEnabled = true;

  return {
    detectChildRequest(chunk: string): void {
      if (KITTY_ENABLE_REGEX.test(chunk)) {
        childRequested = true;
      }
    },

    getState(): KeyboardProtocolState {
      return {
        outerEnabled,
        childRequested,
        effectiveMode: resolveEffectiveMode(outerEnabled, childRequested),
      };
    },

    transformInput(data: string): string {
      if (resolveEffectiveMode(outerEnabled, childRequested) !== "transform") {
        return data;
      }

      return data.split(SHIFT_ENTER_CSI_U).join(BASIC_SHIFT_ENTER);
    },
  };
}

export function createMouseProtocol(): MouseProtocol {
  const state: MutableMouseProtocolState = {
    activeEncoding: "default",
    activeProtocol: "none",
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

export function detectMouseProtocolRequest(chunk: string, state: MutableMouseProtocolState): void {
  for (const match of chunk.matchAll(PRIVATE_MODE_PATTERN)) {
    const action = match[2];
    const modes = parseModes(match[1] ?? "");
    for (const mode of modes) {
      applyMouseMode(state, mode, action);
    }
  }
}

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

function normalizeExitEvent(event: { readonly exitCode?: number; readonly signal?: number }): PtyExitEvent {
  return {
    exitCode: event.exitCode,
    signal: event.signal,
  };
}

function resolveEffectiveMode(outerEnabled: boolean, childRequested: boolean): KeyboardProtocolState["effectiveMode"] {
  return outerEnabled && !childRequested ? "transform" : "passthrough";
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
    state.activeProtocol = "none";
    return;
  }

  if (mode === SGR_ENCODING_MODE || mode === SGR_PIXELS_ENCODING_MODE) {
    state.activeEncoding = "default";
  }
}

function enableMouseMode(state: MutableMouseProtocolState, mode: number): void {
  if (mode === 9) {
    state.activeProtocol = "x10";
    return;
  }

  if (mode === 1000) {
    state.activeProtocol = "vt200";
    return;
  }

  if (mode === 1002) {
    state.activeProtocol = "drag";
    return;
  }

  if (mode === 1003) {
    state.activeProtocol = "any";
    return;
  }

  if (mode === SGR_ENCODING_MODE) {
    state.activeEncoding = "sgr";
    return;
  }

  if (mode === SGR_PIXELS_ENCODING_MODE) {
    state.activeEncoding = "sgr-pixels";
  }
}

function hasWheelProtocol(protocol: MouseProtocolName): boolean {
  return protocol === "vt200" || protocol === "drag" || protocol === "any";
}

function parseModes(rawModes: string): number[] {
  return rawModes
    .split(";")
    .map((mode) => Number.parseInt(mode, 10))
    .filter((mode) => Number.isSafeInteger(mode));
}

function toPublicState(state: MutableMouseProtocolState): MouseProtocolState {
  return {
    activeEncoding: state.activeEncoding,
    activeProtocol: state.activeProtocol,
    mouseTrackingEnabled: hasWheelProtocol(state.activeProtocol) && state.activeEncoding === "sgr",
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
