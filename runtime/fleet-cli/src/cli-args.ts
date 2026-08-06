import {
  ASCII_FLEET_BANNER,
  FLEET_COMMAND,
  GRADIENT_COLORS,
  command,
  dim,
  option,
  paint,
  resolveColorEnabled,
  section,
  stripAnsi,
} from "./styles/index.js";
import { readFleetCliRelease, type FleetCliRelease } from "./release.js";

export interface FleetCliOptions {
  readonly help: boolean;
  readonly passthroughArgs: readonly string[];
}

export interface BuildFleetHelpTextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly release?: FleetCliRelease;
}

const HELP_BANNER_INDENT = "  ";

export function parseFleetCliOptions(argv: readonly string[]): FleetCliOptions {
  const help = argv[0] === "--help" || argv[0] === "-h";
  return {
    help,
    passthroughArgs: help ? argv.slice(1) : [...argv],
  };
}

export function buildFleetHelpText(options: BuildFleetHelpTextOptions = {}): string {
  const release = options.release ?? readFleetCliRelease();
  const colorEnabled = resolveColorEnabled(options);
  const subtitle = `Fleet Harness · ${release.version} · ${release.channel}`;
  const lines = [
    ...ASCII_FLEET_BANNER.map(
      (line: string, index: number) =>
        `${HELP_BANNER_INDENT}${paint(GRADIENT_COLORS[index] ?? FLEET_COMMAND, line, colorEnabled)}`,
    ),
    dim(subtitle, colorEnabled),
    "",
    section("USAGE", colorEnabled),
    `  ${command("fleet", colorEnabled)} ${dim("[claude args...]", colorEnabled)}`,
    `  ${command("fleet auth", colorEnabled)} ${dim("login|list|logout", colorEnabled)}`,
    `  ${command("fleet update", colorEnabled)}`,
    "",
    section("COMMANDS", colorEnabled),
    `  ${command("auth", colorEnabled)}                ${dim("Manage AI Gateway provider authentication.", colorEnabled)}`,
    `  ${command("update", colorEnabled)}              ${dim("Update Fleet CLI packages.", colorEnabled)}`,
    "",
    section("OPTIONS", colorEnabled),
    `  ${option("-h, --help", colorEnabled)}          ${dim("Show this help message and exit.", colorEnabled)}`,
    `  ${dim("Unrecognized arguments are passed through to Claude Code.", colorEnabled)}`,
    "",
  ];
  const text = `${lines.join("\n")}`;
  return colorEnabled ? text : stripAnsi(text);
}
