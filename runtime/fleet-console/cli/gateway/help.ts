import {
  ASCII_FLEET_BANNER,
  FLEET_COMMAND,
  GRADIENT_COLORS,
  command,
  commandRow,
  dim,
  optionRow,
  paint,
  resolveColorEnabled,
  section,
  stripAnsi,
} from "../styles/tokens.js";
import { GATEWAY_SET_KEYS, GATEWAY_SET_KEY_SYNTAX } from "./policy.js";
import { readFleetCliRelease, type FleetCliRelease } from "../release.js";

export interface BuildGatewayHelpTextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly release?: FleetCliRelease;
}

const HELP_BANNER_INDENT = "  ";

export function buildGatewayHelpText(options: BuildGatewayHelpTextOptions = {}): string {
  const release = options.release ?? readFleetCliRelease();
  const colorEnabled = resolveColorEnabled(options);
  const lines = [
    ...ASCII_FLEET_BANNER.map(
      (line: string, index: number) =>
        `${HELP_BANNER_INDENT}${paint(GRADIENT_COLORS[index] ?? FLEET_COMMAND, line, colorEnabled)}`,
    ),
    dim(`Fleet AI Gateway · ${release.version} · ${release.channel}`, colorEnabled),
    "",
    dim("One Anthropic-compatible endpoint over your Codex, Cursor, Kimi, OpenCode,", colorEnabled),
    dim("and xAI subscriptions. Same configuration the Console screen edits.", colorEnabled),
    "",
    section("USAGE", colorEnabled),
    `  ${command("fleet gateway", colorEnabled)} ${dim("[command] [options]", colorEnabled)}`,
    "",
    section("COMMANDS", colorEnabled),
    `  ${dim("(none)", colorEnabled)}              ${dim("Open the interactive configuration screen. (default)", colorEnabled)}`,
    commandRow("serve", "Serve the gateway on its own loopback port.", colorEnabled),
    commandRow("auth", "Sign in or out of a model provider. (login|list|logout)", colorEnabled),
    commandRow("models", "List the models the gateway exposes.", colorEnabled),
    commandRow("status", "Summarize configuration and credential state.", colorEnabled),
    `  ${command("set", colorEnabled)} ${dim("<key> <value>", colorEnabled)}   ${dim("Set one policy axis without the interactive screen.", colorEnabled)}`,
    "",
    section("SET KEYS", colorEnabled),
    ...GATEWAY_SET_KEYS.map((key) => optionRow(key, GATEWAY_SET_KEY_SYNTAX[key], colorEnabled)),
    "",
    section("OPTIONS", colorEnabled),
    optionRow("--port <n>", "serve: listen on a fixed port. Default is ephemeral.", colorEnabled),
    optionRow("--json", "models, status: machine-readable output.", colorEnabled),
    optionRow("-h, --help", "Show this help message and exit.", colorEnabled),
    "",
    section("NOTES", colorEnabled),
    `  ${dim("Model selection is edited on the interactive screen only — a model carries a", colorEnabled)}`,
    `  ${dim("provider, an effort ladder, and a host-only flag, which `set` cannot express.", colorEnabled)}`,
    `  ${dim("`serve` binds 127.0.0.1 and carries no authentication: whatever reaches the", colorEnabled)}`,
    `  ${dim("port spends your subscriptions. Point a client at it with ANTHROPIC_BASE_URL.", colorEnabled)}`,
    "",
  ];
  const text = lines.join("\n");
  return colorEnabled ? text : stripAnsi(text);
}
