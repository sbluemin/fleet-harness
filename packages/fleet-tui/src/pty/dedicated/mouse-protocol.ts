export type MouseProtocolName = "none" | "x10" | "vt200" | "drag" | "any";
export type MouseEncodingName = "default" | "sgr" | "sgr-pixels";

export interface MouseProtocolState {
  readonly activeProtocol: MouseProtocolName;
  readonly activeEncoding: MouseEncodingName;
  readonly mouseTrackingEnabled: boolean;
}

interface MutableMouseProtocolState {
  activeEncoding: MouseEncodingName;
  activeProtocol: MouseProtocolName;
}

export interface MouseProtocol {
  readonly detectChildRequest: (chunk: string) => void;
  readonly getState: () => MouseProtocolState;
}

const PRIVATE_MODE_PATTERN = /\x1b\[\?([0-9;]+)([hl])/g;
const MOUSE_PROTOCOL_MODES = new Set([9, 1000, 1002, 1003]);
const SGR_ENCODING_MODE = 1006;
const SGR_PIXELS_ENCODING_MODE = 1016;

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
