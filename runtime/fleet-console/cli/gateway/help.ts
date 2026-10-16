import {
  command,
  commandRow,
  dim,
  optionRow,
  paintFleetHelpBanner,
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

export function buildGatewayHelpText(options: BuildGatewayHelpTextOptions = {}): string {
  const release = options.release ?? readFleetCliRelease();
  const colorEnabled = resolveColorEnabled(options);
  const lines = [
    ...paintFleetHelpBanner(colorEnabled),
    dim(`Fleet AI Gateway · ${release.version} · ${release.channel}`, colorEnabled),
    "",
    dim("One Anthropic-compatible endpoint over your Codex, Cursor, OpenCode,", colorEnabled),
    dim("and xAI subscriptions. Same configuration the Console screen edits.", colorEnabled),
    "",
    section("USAGE", colorEnabled),
    `  ${command("fleet gateway", colorEnabled)} ${dim("[command] [options]", colorEnabled)}`,
    "",
    section("COMMANDS", colorEnabled),
    `  ${dim("(none)", colorEnabled)}              ${dim("Open the interactive configuration screen. (default)", colorEnabled)}`,
    commandRow("models", "List the models the gateway exposes.", colorEnabled),
    commandRow("status", "Summarize configuration and credential state.", colorEnabled),
    `  ${command("set", colorEnabled)} ${dim("<key> <value>", colorEnabled)}   ${dim("Set one policy axis without the interactive screen.", colorEnabled)}`,
    "",
    section("SET KEYS", colorEnabled),
    ...GATEWAY_SET_KEYS.map((key) => optionRow(key, GATEWAY_SET_KEY_SYNTAX[key], colorEnabled)),
    "",
    section("OPTIONS", colorEnabled),
    optionRow("--json", "models, status: machine-readable output.", colorEnabled),
    optionRow("-h, --help", "Show this help message and exit.", colorEnabled),
    "",
    section("NOTES", colorEnabled),
    `  ${dim("Model selection is edited on the interactive screen only — a model carries a", colorEnabled)}`,
    `  ${dim("provider, an effort ladder, and a host-only flag, which `set` cannot express.", colorEnabled)}`,
    "",
  ];
  const text = lines.join("\n");
  return colorEnabled ? text : stripAnsi(text);
}
