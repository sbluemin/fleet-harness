import { isHostExit, isKeyRelease, isModeToggle, type InputKeybindingConfig } from "./keybindings.js";

type InputToken = string;
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

export interface InputRouterOptions<TMode extends string = string> {
  readonly getLayout?: () => InputRouterLayout;
  readonly initialMode: TMode;
  readonly keybindings: InputKeybindingConfig;
  readonly onExit: () => void;
  readonly onModeChange: (mode: TMode) => void;
  readonly routeDedicatedMouse?: (event: RoutedMouseInput) => boolean;
  readonly routeFleetInput?: (data: string) => boolean;
  readonly routeFleetMouse?: (event: RoutedMouseInput) => boolean;
  readonly toggleMode: (mode: TMode) => TMode;
  readonly writeDedicated: (data: string) => void;
}

export interface InputRouter<TMode extends string = string> {
  readonly getMode: () => TMode;
  readonly route: (data: string) => { readonly consume: boolean };
}

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/;
const SGR_MOUSE_WHEEL_UP = 64;
const SGR_MOUSE_WHEEL_DOWN = 65;

export function createInputRouter<TMode extends string = string>(options: InputRouterOptions<TMode>): InputRouter<TMode> {
  let mode = options.initialMode;

  return {
    getMode: () => mode,
    route(data: string) {
      let dedicatedOutput = "";
      for (const token of splitInputChunk(data)) {
        const mouseInput = parseSgrMouseInput(token);
        if (mouseInput !== null && routeMouseInput(mouseInput, options)) {
          continue;
        }

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

function clampLayout(layout: InputRouterLayout): InputRouterLayout {
  return {
    columns: Math.max(0, Math.floor(layout.columns)),
    dedicatedRows: Math.max(0, Math.floor(layout.dedicatedRows)),
    fleetRows: Math.max(0, Math.floor(layout.fleetRows)),
    totalRows: Math.max(0, Math.floor(layout.totalRows)),
  };
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

function routeMouseInput<TMode extends string>(event: SgrMouseInput, options: InputRouterOptions<TMode>): boolean {
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
