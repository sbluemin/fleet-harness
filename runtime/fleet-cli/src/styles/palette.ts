export type RgbTuple = readonly [number, number, number];

export const FLEET_ACCENT = "\x1b[38;2;254;188;56m";
export const FLEET_OPTION = "\x1b[38;2;125;211;252m";
export const FLEET_COMMAND = "\x1b[38;2;94;234;212m";
export const DIM_COLOR = "\x1b[38;5;244m";
export const GRADIENT_RGBS: readonly RgbTuple[] = [
  [0, 255, 255],
  [0, 215, 255],
  [0, 175, 255],
  [0, 135, 255],
  [0, 95, 255],
  [0, 0, 255],
];
export const GRADIENT_COLORS: readonly string[] = [
  "\x1b[38;2;0;255;255m",
  "\x1b[38;2;0;215;255m",
  "\x1b[38;2;0;175;255m",
  "\x1b[38;2;0;135;255m",
  "\x1b[38;2;0;95;255m",
  "\x1b[38;2;0;0;255m",
];
