export interface FleetCliOptions {
  readonly cliId?: string;
  readonly cursorSync: boolean;
  readonly help: boolean;
  readonly model?: string;
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

Fleet Agent Options:
  -h, --help          Show this help message and exit.
  -c, --cli <id>      Select the dedicated CLI to embed (claude | claude-zai | claude-kimi | codex).
                      Default: claude. Env override: FLEET_DEDICATED_CLI.
  -n, --native        Run the dedicated CLI in native mode: do not inject
                      the Fleet system prompt and hide the Fleet Action
                      Protocol label from the Fleet PTY (divider preserved).
  --disable-cursor-sync
                      Disable outer-terminal cursor projection for terminals
                      with problematic IME cursor anchoring.
  -rsp, --replace-system-prompt  Replace the Claude system prompt instead of appending it.
  -em, --enable-metaphor         Enable the fleet-world tone overlay in the injected system prompt.

Underlying CLI Options (forwarded to selected CLI):
  --model <name>      Forward the model name to the selected dedicated CLI.
`;

export function parseFleetCliOptions(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): FleetCliOptions {
  let cliId: string | undefined;
  let cursorSync = parseCursorSyncEnv(env.FLEET_CURSOR_SYNC);
  let help = false;
  let model: string | undefined;
  let native = false;
  let replaceSystemPrompt = false;
  let enableMetaphor = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--cli" || arg === "-c") {
      cliId = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--cli=")) {
      cliId = arg.slice("--cli=".length);
    } else if (arg.startsWith("-c=")) {
      cliId = arg.slice("-c=".length);
    } else if (arg === "--model") {
      model = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg === "--native" || arg === "-n") {
      native = true;
    } else if (arg === "--disable-cursor-sync") {
      cursorSync = false;
    } else if (arg === "--replace-system-prompt" || arg === "-rsp") {
      replaceSystemPrompt = true;
    } else if (arg === "--enable-metaphor" || arg === "-em") {
      enableMetaphor = true;
    }
  }
  return { cliId, cursorSync, help, model, native, replaceSystemPrompt, enableMetaphor };
}

function parseCursorSyncEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}
