import type { MouseEncodingName, MouseProtocolName, MouseProtocolState } from "../types.js";

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
