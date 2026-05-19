export interface FleetCliOptions {
  readonly help: boolean;
  readonly native: boolean;
}

export const FLEET_HELP_TEXT = `fleet — Fleet CLI host

Usage:
  fleet [options]

Options:
  -h, --help          Show this help message and exit.
  -c, --cli <id>      Select the dedicated CLI to embed (claude | codex).
                      Default: claude. Env override: FLEET_DEDICATED_CLI.
  -n, --native        Run the dedicated CLI in native mode: do not inject
                      the Fleet system prompt and hide the Fleet Action
                      Protocol label from the Fleet PTY (divider preserved).
`;

export function parseFleetCliOptions(argv: readonly string[]): FleetCliOptions {
  let help = false;
  let native = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--native" || arg === "-n") {
      native = true;
    }
  }
  return { help, native };
}
