import {
  ANSI_BOLD,
  ANSI_DIM,
  ANSI_RESET,
  ASCII_FLEET_BANNER,
  FLEET_ACCENT,
  FLEET_COMMAND,
  FLEET_OPTION,
  GRADIENT_COLORS,
} from "./cli-style.js";
import { readFleetCliRelease, type FleetCliRelease } from "./release.js";

export interface FleetCliOptions {
  readonly cursorSync: boolean;
  readonly argvOverrides: FleetCliArgOverrides;
  readonly help: boolean;
}

export interface FleetCliArgOverrides {
  readonly cursorSync: boolean;
}

export interface BuildFleetHelpTextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly release?: FleetCliRelease;
}

type MutableFleetCliArgOverrides = {
  -readonly [Key in keyof FleetCliArgOverrides]: FleetCliArgOverrides[Key];
};

const HELP_BANNER_INDENT = "  ";
const HELP_HINT = "Run 'fleet --help' for usage.";
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function parseFleetCliOptions(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): FleetCliOptions {
  let cursorSync = parseCursorSyncEnv(env.FLEET_CURSOR_SYNC);
  let help = false;
  const argvOverrides = createEmptyArgOverrides();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--disable-cursor-sync") {
      cursorSync = false;
      argvOverrides.cursorSync = true;
    } else {
      throw new Error(formatUnknownFleetOption(arg));
    }
  }
  return { cursorSync, argvOverrides, help };
}

export function buildFleetHelpText(options: BuildFleetHelpTextOptions = {}): string {
  const release = options.release ?? readFleetCliRelease();
  const colorEnabled = resolveColorEnabled(options);
  const subtitle = `Fleet Harness · ${release.version} · ${release.channel}`;
  const lines = [
    ...ASCII_FLEET_BANNER.map(
      (line, index) => `${HELP_BANNER_INDENT}${paintLine(GRADIENT_COLORS[index] ?? FLEET_COMMAND, line, colorEnabled)}`,
    ),
    dim(subtitle, colorEnabled),
    "",
    section("USAGE", colorEnabled),
    `  ${command("fleet", colorEnabled)} ${dim("[options]", colorEnabled)}`,
    `  ${command("fleet auth login", colorEnabled)} ${dim("[claude-zai|claude-kimi]", colorEnabled)}`,
    `  ${command("fleet auth list", colorEnabled)}`,
    `  ${command("fleet auth logout", colorEnabled)} ${dim("[claude-zai|claude-kimi]", colorEnabled)}`,
    `  ${command("fleet wiki", colorEnabled)} ${dim("[--port <port>] [--stop] [--help]", colorEnabled)}`,
    "",
    section("COMMANDS", colorEnabled),
    `  ${command("auth", colorEnabled)}                ${dim("Manage Fleet authentication.", colorEnabled)}`,
    `  ${command("wiki", colorEnabled)}                ${dim("Run Fleet Wiki.", colorEnabled)}`,
    "",
    section("OPTIONS", colorEnabled),
    `  ${option("-h, --help", colorEnabled)}          ${dim("Show this help message and exit.", colorEnabled)}`,
    `  ${option("--disable-cursor-sync", colorEnabled)}`,
    `                      ${dim("Disable outer-terminal cursor projection for terminals", colorEnabled)}`,
    `                      ${dim("with problematic IME cursor anchoring.", colorEnabled)}`,
    "",
  ];
  const text = `${lines.join("\n")}`;
  return colorEnabled ? text : stripAnsi(text);
}

function createEmptyArgOverrides(): MutableFleetCliArgOverrides {
  return {
    cursorSync: false,
  };
}

function formatUnknownFleetOption(option: string): string {
  return `Unknown fleet option: ${option}\n${HELP_HINT}`;
}

function resolveColorEnabled(options: BuildFleetHelpTextOptions): boolean {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? process.stdout.isTTY;
  return isTTY === true && env.NO_COLOR === undefined;
}

function section(text: string, colorEnabled: boolean): string {
  return paint(`${ANSI_BOLD}${FLEET_ACCENT}`, text, colorEnabled);
}

function command(text: string, colorEnabled: boolean): string {
  return paint(FLEET_COMMAND, text, colorEnabled);
}

function option(text: string, colorEnabled: boolean): string {
  return paint(FLEET_OPTION, text, colorEnabled);
}

function dim(text: string, colorEnabled: boolean): string {
  return paint(ANSI_DIM, text, colorEnabled);
}

function paintLine(color: string, text: string, colorEnabled: boolean): string {
  return paint(color, text, colorEnabled);
}

function paint(color: string, text: string, colorEnabled: boolean): string {
  if (!colorEnabled) {
    return text;
  }
  return `${color}${text}${ANSI_RESET}`;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function parseCursorSyncEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}
