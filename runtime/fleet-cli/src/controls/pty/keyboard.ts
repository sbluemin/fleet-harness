import type { KeyboardProtocolState } from "../types.js";

export interface KeyboardProtocol {
  detectChildRequest(chunk: string): void;
  getState(): KeyboardProtocolState;
  transformInput(data: string): string;
}

export const KITTY_ENABLE = "\x1b[>4;2m\x1b[>1u";
export const KITTY_DISABLE = "\x1b[<u\x1b[>4;0m";
export const KITTY_ENABLE_REGEX = /\x1b\[>(?:\d+u|4;\d+m)/;

const SHIFT_ENTER_CSI_U = "\x1b[13;2u";
const BASIC_SHIFT_ENTER = "\n";

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

export function encodeTerminalInput(data: string, protocol?: KeyboardProtocol): string {
  return protocol?.transformInput(data) ?? data;
}

function resolveEffectiveMode(outerEnabled: boolean, childRequested: boolean): KeyboardProtocolState["effectiveMode"] {
  return outerEnabled && !childRequested ? "transform" : "passthrough";
}
