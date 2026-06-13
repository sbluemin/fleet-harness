import { parseSgrMouseInput, type InputRouterLayout, type RoutedMouseInput } from "../mouse/parser.js";
import { routeMouseInput } from "../mouse/router.js";
import { isKeyRelease } from "./contract.js";
import type { InputKeybindingConfig } from "./keybindings.js";

type InputToken = string;

export interface InputRouterOptions {
  readonly getLayout?: () => InputRouterLayout;
  readonly keybindings: InputKeybindingConfig;
  readonly routeDedicatedMouse?: (event: RoutedMouseInput) => boolean;
  readonly routeFleetMouse?: (event: RoutedMouseInput) => boolean;
  readonly writeDedicated: (data: string) => void;
}

export interface InputRouter {
  readonly route: (data: string) => { readonly consume: boolean };
}

export function createInputRouter(options: InputRouterOptions): InputRouter {
  return {
    route(data: string) {
      let dedicatedOutput = "";
      for (const token of splitInputChunk(data)) {
        const mouseInput = parseSgrMouseInput(token);
        if (mouseInput !== null && routeMouseInput(mouseInput, options)) {
          continue;
        }

        if (isKeyRelease(token)) {
          continue;
        }

        if (options.keybindings.dispatch(token)) {
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
