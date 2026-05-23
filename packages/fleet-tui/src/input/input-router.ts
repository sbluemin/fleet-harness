import { isHostExit, isKeyRelease, isModeToggle, type InputKeybindingConfig } from "./keybindings.js";

type InputToken = string;

export interface InputRouterOptions<TMode extends string = string> {
  readonly initialMode: TMode;
  readonly keybindings: InputKeybindingConfig;
  readonly onExit: () => void;
  readonly onModeChange: (mode: TMode) => void;
  readonly routeFleetInput?: (data: string) => boolean;
  readonly toggleMode: (mode: TMode) => TMode;
  readonly writeDedicated: (data: string) => void;
}

export interface InputRouter<TMode extends string = string> {
  readonly getMode: () => TMode;
  readonly route: (data: string) => { readonly consume: boolean };
}

export function createInputRouter<TMode extends string = string>(options: InputRouterOptions<TMode>): InputRouter<TMode> {
  let mode = options.initialMode;

  return {
    getMode: () => mode,
    route(data: string) {
      let dedicatedOutput = "";
      for (const token of splitInputChunk(data)) {
        if (isHostExit(token, options.keybindings)) {
          if (dedicatedOutput.length > 0) {
            options.writeDedicated(dedicatedOutput);
          }
          options.onExit();
          return { consume: true };
        }

        if (isKeyRelease(token)) {
          continue;
        }

        if (options.keybindings.dispatch(token)) {
          continue;
        }

        if (isModeToggle(token, options.keybindings)) {
          if (dedicatedOutput.length > 0) {
            options.writeDedicated(dedicatedOutput);
            dedicatedOutput = "";
          }
          mode = options.toggleMode(mode);
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
