import {
  ASCII_FLEET_BANNER,
  FLEET_COMMAND,
  GRADIENT_COLORS,
  command,
  commandRow,
  dim,
  option,
  optionRow,
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

/** SETTINGS 항목은 명령이 아니라 경로·환경변수라 이름이 길다 — 그 격자만 따로 넓힌다. */
const SETTINGS_COLUMN = 28;

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
    `  ${command("fleet", colorEnabled)} ${dim("<runtime> [command] [options]", colorEnabled)}`,
    "",
    section("RUNTIME", colorEnabled),
    commandRow("cli", "Launch Claude Code through the Fleet AI Gateway. Bare `fleet` does the same.", colorEnabled),
    commandRow("console", "Run the local Fleet Console server and open it.", colorEnabled),
    commandRow("gateway", "Configure the AI Gateway. Opens an interactive screen.", colorEnabled),
    "",
    section("RUNTIME COMMANDS", colorEnabled),
    commandRow("console", "start · stop · restart · status", colorEnabled),
    commandRow("gateway", "serve · auth · models · status · set", colorEnabled),
    `  ${dim("Run `fleet <runtime> --help` for what each one does and the options it takes.", colorEnabled)}`,
    "",
    section("SETTINGS", colorEnabled),
    optionRow("~/.fleet/settings.json", "Console-wide settings — port, remote access, theme, language.", colorEnabled, SETTINGS_COLUMN),
    optionRow("~/.fleet/ai-gateway.json", "AI Gateway model selection and policy.", colorEnabled, SETTINGS_COLUMN),
    optionRow("FLEET_DATA_DIR", "Relocate the Fleet data root that holds both files.", colorEnabled, SETTINGS_COLUMN),
    optionRow("FLEET_GATEWAY_WIRE_LOG", "Log gateway wire traffic unless the stored toggle decides it.", colorEnabled, SETTINGS_COLUMN),
    optionRow("NO_COLOR", "Disable colored output.", colorEnabled, SETTINGS_COLUMN),
    "",
    section("MAINTENANCE", colorEnabled),
    `${commandRow("update", "Update the Fleet Console package.", colorEnabled)} ${option("[--check]", colorEnabled)}`,
    commandRow("doctor", "Report install, PATH, auth, and Console health without changing anything.", colorEnabled),
    commandRow("version", "Print the Fleet package version and exit.", colorEnabled),
    commandRow("status", "Show the local Fleet Console server status. Alias of `fleet console status`.", colorEnabled),
    "",
    section("OPTIONS", colorEnabled),
    optionRow("-h, --help", "Show this help message and exit.", colorEnabled),
    optionRow("-v, --version", "Print the Fleet package version and exit.", colorEnabled),
    `  ${dim("Unrecognized arguments are passed through to Claude Code.", colorEnabled)}`,
    "",
  ];
  const text = `${lines.join("\n")}`;
  return colorEnabled ? text : stripAnsi(text);
}
