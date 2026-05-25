import { ANSI_BOLD, ANSI_DIM, paint } from "./ansi.js";
import { FLEET_ACCENT, FLEET_COMMAND, FLEET_OPTION } from "./palette.js";

export interface ResolveColorEnabledOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
}

export function resolveColorEnabled(options: ResolveColorEnabledOptions = {}): boolean {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? process.stdout.isTTY;
  return isTTY === true && env.NO_COLOR === undefined;
}

export function section(text: string, colorEnabled: boolean): string {
  return paint(`${ANSI_BOLD}${FLEET_ACCENT}`, text, colorEnabled);
}

export function command(text: string, colorEnabled: boolean): string {
  return paint(FLEET_COMMAND, text, colorEnabled);
}

export function option(text: string, colorEnabled: boolean): string {
  return paint(FLEET_OPTION, text, colorEnabled);
}

export function dim(text: string, colorEnabled: boolean): string {
  return paint(ANSI_DIM, text, colorEnabled);
}
