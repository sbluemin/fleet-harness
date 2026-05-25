export interface FleetCliOptions {
  readonly cursorSync: boolean;
  readonly argvOverrides: FleetCliArgOverrides;
  readonly help: boolean;
  readonly native: boolean;
  readonly replaceSystemPrompt: boolean;
  readonly enableMetaphor: boolean;
}

export interface FleetCliArgOverrides {
  readonly cursorSync: boolean;
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
  -n, --native        Run the agent CLI in native mode: do not inject
                      the Fleet system prompt and hide the Fleet Action
                      Protocol label from the Fleet PTY (divider preserved).
  --disable-cursor-sync
                      Disable outer-terminal cursor projection for terminals
                      with problematic IME cursor anchoring.
  -rsp, --replace-system-prompt  Toggle system prompt to append mode (default: replace).
  -em, --enable-metaphor         Enable the fleet-world tone overlay in the injected system prompt.
`;

export function parseFleetCliOptions(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): FleetCliOptions {
  let cursorSync = parseCursorSyncEnv(env.FLEET_CURSOR_SYNC);
  let help = false;
  let native = false;
  let replaceSystemPrompt = true;
  let enableMetaphor = false;
  const argvOverrides = createEmptyArgOverrides();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--native" || arg === "-n") {
      native = true;
      argvOverrides.native = true;
    } else if (arg === "--disable-cursor-sync") {
      cursorSync = false;
      argvOverrides.cursorSync = true;
    } else if (arg === "--replace-system-prompt" || arg === "-rsp") {
      replaceSystemPrompt = false;
      argvOverrides.replaceSystemPrompt = true;
    } else if (arg === "--enable-metaphor" || arg === "-em") {
      enableMetaphor = true;
      argvOverrides.enableMetaphor = true;
    } else {
      throw new Error(formatUnknownFleetOption(arg));
    }
  }
  return { cursorSync, argvOverrides, help, native, replaceSystemPrompt, enableMetaphor };
}

function createEmptyArgOverrides(): MutableFleetCliArgOverrides {
  return {
    cursorSync: false,
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
