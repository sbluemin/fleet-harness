export interface FleetCliOptions {
  readonly cliId?: string;
  readonly cursorSync: boolean;
  readonly argvOverrides: FleetCliArgOverrides;
  readonly help: boolean;
  readonly model?: string;
  readonly native: boolean;
  readonly replaceSystemPrompt: boolean;
  readonly enableMetaphor: boolean;
}

export interface FleetCliArgOverrides {
  readonly cliId: boolean;
  readonly cursorSync: boolean;
  readonly model: boolean;
  readonly native: boolean;
  readonly replaceSystemPrompt: boolean;
  readonly enableMetaphor: boolean;
}

type MutableFleetCliArgOverrides = {
  -readonly [Key in keyof FleetCliArgOverrides]: FleetCliArgOverrides[Key];
};

const HELP_HINT = "Run 'fleet --help' for usage.";

export const FLEET_HELP_TEXT = `fleet — Fleet Harness

Usage:
  fleet [options]
  fleet auth login [claude-zai|claude-kimi]
  fleet auth list
  fleet auth logout [claude-zai|claude-kimi]
  fleet wiki [--port <port>] [--stop] [--help]

Commands:
  auth                Manage Fleet authentication.
  wiki                Run Fleet Wiki.

Fleet Agent Options:
  -h, --help          Show this help message and exit.
  -c, --cli <id>      Select the agent CLI to embed (claude | claude-zai | claude-kimi | codex).
                      Default: claude. Env override: FLEET_AGENT_CLI.
  -n, --native        Run the agent CLI in native mode: do not inject
                      the Fleet system prompt and hide the Fleet Action
                      Protocol label from the Fleet PTY (divider preserved).
  --disable-cursor-sync
                      Disable outer-terminal cursor projection for terminals
                      with problematic IME cursor anchoring.
  -rsp, --replace-system-prompt  Replace the Claude system prompt instead of appending it.
  -em, --enable-metaphor         Enable the fleet-world tone overlay in the injected system prompt.

Underlying CLI Options (forwarded to selected CLI):
  --model <name>      Forward the model name to the selected agent CLI.
`;

export function parseFleetCliOptions(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): FleetCliOptions {
  let cliId: string | undefined;
  let cursorSync = parseCursorSyncEnv(env.FLEET_CURSOR_SYNC);
  let help = false;
  let model: string | undefined;
  let native = false;
  let replaceSystemPrompt = false;
  let enableMetaphor = false;
  const argvOverrides = createEmptyArgOverrides();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--cli" || arg === "-c") {
      cliId = argv[index + 1];
      argvOverrides.cliId = true;
      index += 1;
    } else if (arg.startsWith("--cli=")) {
      cliId = arg.slice("--cli=".length);
      argvOverrides.cliId = true;
    } else if (arg.startsWith("-c=")) {
      cliId = arg.slice("-c=".length);
      argvOverrides.cliId = true;
    } else if (arg === "--model") {
      model = argv[index + 1];
      argvOverrides.model = true;
      index += 1;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      argvOverrides.model = true;
    } else if (arg === "--native" || arg === "-n") {
      native = true;
      argvOverrides.native = true;
    } else if (arg === "--disable-cursor-sync") {
      cursorSync = false;
      argvOverrides.cursorSync = true;
    } else if (arg === "--replace-system-prompt" || arg === "-rsp") {
      replaceSystemPrompt = true;
      argvOverrides.replaceSystemPrompt = true;
    } else if (arg === "--enable-metaphor" || arg === "-em") {
      enableMetaphor = true;
      argvOverrides.enableMetaphor = true;
    } else {
      throw new Error(formatUnknownFleetOption(arg));
    }
  }
  return { cliId, cursorSync, argvOverrides, help, model, native, replaceSystemPrompt, enableMetaphor };
}

function createEmptyArgOverrides(): MutableFleetCliArgOverrides {
  return {
    cliId: false,
    cursorSync: false,
    model: false,
    native: false,
    replaceSystemPrompt: false,
    enableMetaphor: false,
  };
}

function formatUnknownFleetOption(option: string): string {
  return `Unknown fleet option: ${option}\n${HELP_HINT}`;
}

function parseCursorSyncEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}
