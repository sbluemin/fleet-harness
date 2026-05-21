export interface FleetCliOptions {
  readonly help: boolean;
  readonly native: boolean;
  readonly replaceSystemPrompt: boolean;
  readonly enableMetaphor: boolean;
}

export const FLEET_HELP_TEXT = `fleet — Fleet Harness

Usage:
  fleet [options]
  fleet auth login [claude-zai|claude-kimi]
  fleet auth list
  fleet auth logout [claude-zai|claude-kimi]

Options:
  -h, --help          Show this help message and exit.
  -c, --cli <id>      Select the dedicated CLI to embed (claude | claude-zai | claude-kimi | codex).
                      Default: claude. Env override: FLEET_DEDICATED_CLI.
  -n, --native        Run the dedicated CLI in native mode: do not inject
                      the Fleet system prompt and hide the Fleet Action
                      Protocol label from the Fleet PTY (divider preserved).
  -rsp, --replace-system-prompt  Replace the Claude system prompt instead of appending it.
  -em, --enable-metaphor         Enable the fleet-world tone overlay in the injected system prompt.
`;

export function parseFleetCliOptions(argv: readonly string[]): FleetCliOptions {
  let help = false;
  let native = false;
  let replaceSystemPrompt = false;
  let enableMetaphor = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--native" || arg === "-n") {
      native = true;
    } else if (arg === "--replace-system-prompt" || arg === "-rsp") {
      replaceSystemPrompt = true;
    } else if (arg === "--enable-metaphor" || arg === "-em") {
      enableMetaphor = true;
    }
  }
  return { help, native, replaceSystemPrompt, enableMetaphor };
}
