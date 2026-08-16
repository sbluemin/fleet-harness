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
} from "./styles/tokens.js";
import { readFleetCliRelease, type FleetCliRelease } from "./release.js";

export interface FleetCliOptions {
  readonly help: boolean;
  readonly passthroughArgs: readonly string[];
}

export function isFleetVersionArg(value: string | undefined): boolean {
  return value === "--version" || value === "-v" || value === "version";
}

export function buildFleetVersionText(release: FleetCliRelease = readFleetCliRelease()): string {
  return `@dotobokuri/fleet-console ${release.version} (${release.channel})\nClaude Code version: fleet cli --version\n`;
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
    `  ${command("fleet cli", colorEnabled)} ${dim("[claude args...]", colorEnabled)}`,
    `  ${command("fleet console", colorEnabled)} ${dim("[start|stop|restart|status] [--help]", colorEnabled)}`,
    `  ${command("fleet auth", colorEnabled)} ${dim("login|list|logout", colorEnabled)}`,
    `  ${command("fleet update", colorEnabled)} ${dim("[--check]", colorEnabled)}`,
    `  ${command("fleet version", colorEnabled)}`,
    `  ${command("fleet doctor", colorEnabled)}`,
    `  ${command("fleet status", colorEnabled)}`,
    "",
    section("COMMANDS", colorEnabled),
    `  ${command("cli", colorEnabled)}                 ${dim("Launch Claude Code through the thin Fleet gateway (synonym of bare fleet).", colorEnabled)}`,
    `  ${command("console", colorEnabled)}             ${dim("Manage the local Fleet Console server.", colorEnabled)}`,
    `  ${command("auth", colorEnabled)}                ${dim("Manage AI Gateway provider authentication.", colorEnabled)}`,
    `  ${command("update", colorEnabled)}              ${dim("Update the Fleet Console package (owns fleet and fleet-console).", colorEnabled)}`,
    `  ${command("version", colorEnabled)}             ${dim("Print the Fleet package version and exit.", colorEnabled)}`,
    `  ${command("doctor", colorEnabled)}              ${dim("Report install, PATH, auth, and Console health without changing anything.", colorEnabled)}`,
    `  ${command("status", colorEnabled)}              ${dim("Show the local Fleet Console server status (same as fleet console status).", colorEnabled)}`,
    "",
    section("OPTIONS", colorEnabled),
    `  ${option("-h, --help", colorEnabled)}          ${dim("Show this help message and exit.", colorEnabled)}`,
    `  ${option("-v, --version", colorEnabled)}       ${dim("Print the Fleet package version and exit.", colorEnabled)}`,
    `  ${dim("Unrecognized arguments are passed through to Claude Code.", colorEnabled)}`,
    "",
  ];
  const text = `${lines.join("\n")}`;
  return colorEnabled ? text : stripAnsi(text);
}
