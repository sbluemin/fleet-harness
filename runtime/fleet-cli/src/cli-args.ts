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
  readonly cursorSync: boolean;
  readonly cursorSyncExplicitlyEnabled: boolean;
  readonly argvOverrides: FleetCliArgOverrides;
  readonly help: boolean;
  readonly nativeTerminal: boolean;
}

export interface FleetCliArgOverrides {
  readonly cursorSync: boolean;
}

export interface BuildFleetHelpTextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly release?: FleetCliRelease;
}

export type FleetHookCommand = "subagents-context";

type MutableFleetCliArgOverrides = {
  -readonly [Key in keyof FleetCliArgOverrides]: FleetCliArgOverrides[Key];
};

const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const HELP_BANNER_INDENT = "  ";
const HELP_HINT = "Run 'fleet --help' for usage.";
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function parseFleetCliOptions(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): FleetCliOptions {
  const cursorSyncEnv = parseCursorSyncEnv(env.FLEET_CURSOR_SYNC);
  let cursorSync = cursorSyncEnv.value;
  let cursorSyncExplicitlyEnabled = cursorSyncEnv.explicitlyEnabled;
  let help = false;
  let nativeTerminal = false;
  const argvOverrides = createEmptyArgOverrides();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--native") {
      nativeTerminal = true;
    } else if (arg === "--disable-cursor-sync") {
      cursorSync = false;
      cursorSyncExplicitlyEnabled = false;
      argvOverrides.cursorSync = true;
    } else {
      throw new Error(formatUnknownFleetOption(arg));
    }
  }
  return { cursorSync, cursorSyncExplicitlyEnabled, argvOverrides, help, nativeTerminal };
}

export function parseFleetHookCommand(argv: readonly string[]): FleetHookCommand {
  if (argv[0] === "subagents-context" && argv.length === 1) return "subagents-context";
  throw new Error("Unknown fleet hook command. Run 'fleet hook subagents-context'.");
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
    `  ${command("fleet", colorEnabled)} ${dim("[options]", colorEnabled)}`,
    `  ${command("fleet auth", colorEnabled)} ${dim("<login|list|logout> [claude-zai|claude-kimi]", colorEnabled)}`,
    `  ${command("fleet hook subagents-context", colorEnabled)}`,
    `  ${command("fleet wiki", colorEnabled)} ${dim("[--host <addr>] [--port <port>] [--stop] [--help]", colorEnabled)}`,
    `  ${command("fleet console", colorEnabled)} ${dim("[--help]", colorEnabled)}`,
    `  ${command("fleet update", colorEnabled)}`,
    "",
    section("COMMANDS", colorEnabled),
    `  ${command("auth", colorEnabled)}                ${dim("Manage Fleet authentication.", colorEnabled)}`,
    `  ${command("hook", colorEnabled)}                ${dim("Run non-interactive Fleet hook helpers.", colorEnabled)}`,
    `  ${command("wiki", colorEnabled)}                ${dim("Run Fleet Wiki.", colorEnabled)}`,
    `  ${command("console", colorEnabled)}             ${dim("Open Fleet Console in your browser.", colorEnabled)}`,
    `  ${command("update", colorEnabled)}              ${dim("Update Fleet CLI packages.", colorEnabled)}`,
    "",
    section("OPTIONS", colorEnabled),
    `  ${option("-h, --help", colorEnabled)}          ${dim("Show this help message and exit.", colorEnabled)}`,
    `  ${option("--native", colorEnabled)}           ${dim("Run the selected Agent CLI in the real terminal", colorEnabled)}`,
    `                      ${dim("after the Mission Control launcher.", colorEnabled)}`,
    `  ${option("--disable-cursor-sync", colorEnabled)}`,
    `                      ${dim("Disable outer-terminal cursor projection for terminals", colorEnabled)}`,
    `                      ${dim("with problematic IME cursor anchoring.", colorEnabled)}`,
    `                      ${dim("Claude Code on Windows defaults to disabled; set", colorEnabled)}`,
    `                      ${dim("FLEET_CURSOR_SYNC=1 to override.", colorEnabled)}`,
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

function parseCursorSyncEnv(value: string | undefined): { readonly explicitlyEnabled: boolean; readonly value: boolean } {
  if (value === undefined) {
    return { explicitlyEnabled: false, value: true };
  }

  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return { explicitlyEnabled: true, value: true };
  }

  if (FALSE_VALUES.has(normalized)) {
    return { explicitlyEnabled: false, value: false };
  }

  return { explicitlyEnabled: false, value: true };
}
