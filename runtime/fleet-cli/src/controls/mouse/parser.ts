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
