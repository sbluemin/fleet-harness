export interface FleetCliOptions {
  readonly help: boolean;
  readonly native: boolean;
  readonly replaceSystemPrompt: boolean;
  readonly disableMetaphor: boolean;
}

export const FLEET_HELP_TEXT = `fleet — Fleet Harness

Usage:
  fleet [options]

Options:
  -h, --help          Show this help message and exit.
  -c, --cli <id>      Select the dedicated CLI to embed (claude | codex).
                      Default: claude. Env override: FLEET_DEDICATED_CLI.
  -n, --native        Run the dedicated CLI in native mode: do not inject
                      the Fleet system prompt and hide the Fleet Action
                      Protocol label from the Fleet PTY (divider preserved).
  -rsp, --replace-system-prompt  Replace the Claude system prompt instead of appending it.
  -dm, --disable-metaphor        Disable the fleet-world tone overlay in the injected system prompt.
`;

export function parseFleetCliOptions(argv: readonly string[]): FleetCliOptions {
  let help = false;
  let native = false;
  let replaceSystemPrompt = false;
  let disableMetaphor = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--native" || arg === "-n") {
      native = true;
    } else if (arg === "--replace-system-prompt" || arg === "-rsp") {
      replaceSystemPrompt = true;
    } else if (arg === "--disable-metaphor" || arg === "-dm") {
      disableMetaphor = true;
    }
  }
  return { help, native, replaceSystemPrompt, disableMetaphor };
}
