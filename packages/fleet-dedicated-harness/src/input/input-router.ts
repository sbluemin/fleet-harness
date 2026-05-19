import { dispatchRegisteredKeybinding, isHostExit, isKeyRelease, isModeToggle } from "./keybindings.js";
import { toggleFleetInputMode, type FleetInputMode } from "./modes.js";

type InputToken = string;

export interface InputRouterOptions {
  readonly onExit: () => void;
  readonly onModeChange: (mode: FleetInputMode) => void;
  readonly routeFleetInput?: (data: string) => boolean;
  readonly writeDedicated: (data: string) => void;
}

export interface InputRouter {
  readonly getMode: () => FleetInputMode;
  readonly route: (data: string) => { readonly consume: boolean };
}

export function createInputRouter(options: InputRouterOptions): InputRouter {
  let mode: FleetInputMode = "MIRROR";

  return {
    getMode: () => mode,
    route(data: string) {
      let dedicatedOutput = "";
      for (const token of splitInputChunk(data)) {
        if (isHostExit(token)) {
          if (dedicatedOutput.length > 0) {
            options.writeDedicated(dedicatedOutput);
          }
          options.onExit();
          return { consume: true };
        }

        if (isKeyRelease(token)) {
          continue;
        }

        if (dispatchRegisteredKeybinding(token)) {
          continue;
        }

        if (isModeToggle(token)) {
          if (dedicatedOutput.length > 0) {
            options.writeDedicated(dedicatedOutput);
            dedicatedOutput = "";
          }
          mode = toggleFleetInputMode(mode);
          options.onModeChange(mode);
          continue;
        }

        if (options.routeFleetInput?.(token)) {
          continue;
        }

        dedicatedOutput += token;
      }

      if (dedicatedOutput.length > 0) {
        options.writeDedicated(dedicatedOutput);
      }
      return { consume: true };
    },
  };
}

function splitInputChunk(data: string): InputToken[] {
  const tokens: InputToken[] = [];
  let index = 0;
  while (index < data.length) {
    const char = data[index];
    if (char === "\x1b") {
      const end = readEscapeSequenceEnd(data, index);
      tokens.push(data.slice(index, end));
      index = end;
      continue;
    }

    if (isControlCharacter(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }

    const next = readPrintableRunEnd(data, index);
    tokens.push(data.slice(index, next));
    index = next;
  }
  return tokens;
}

function readEscapeSequenceEnd(data: string, start: number): number {
  const prefix = data[start + 1];
  if (prefix !== "[") {
    return Math.min(data.length, start + 2);
  }

  let index = start + 2;
  while (index < data.length) {
    const code = data.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) {
      return index;
    }
  }
  return data.length;
}

function readPrintableRunEnd(data: string, start: number): number {
  let index = start;
  while (index < data.length && data[index] !== "\x1b" && !isControlCharacter(data[index])) {
    index += 1;
  }
  return index;
}

function isControlCharacter(char: string): boolean {
  if (char.length === 0) {
    return false;
  }

  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}
