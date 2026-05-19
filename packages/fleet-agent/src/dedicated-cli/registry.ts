import { claudeCli } from "./claude/claude.js";
import { codexCli } from "./codex/codex.js";
import type { DedicatedCliDefinition, DedicatedCliId, DedicatedCliProfile } from "./types.js";

const DEFAULT_CLI_ID: DedicatedCliId = "claude";
const DEFINITIONS: Record<DedicatedCliId, DedicatedCliDefinition> = {
  claude: claudeCli,
  codex: codexCli,
};

export function resolveDedicatedCliProfile(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): DedicatedCliProfile {
  const id = parseCliId(argv) ?? parseEnvCliId(env.FLEET_DEDICATED_CLI) ?? DEFAULT_CLI_ID;
  return DEFINITIONS[id].createProfile({ cwd, env });
}

export function getDedicatedCliIds(): DedicatedCliId[] {
  return Object.keys(DEFINITIONS) as DedicatedCliId[];
}

function parseCliId(argv: readonly string[]): DedicatedCliId | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli") {
      return parseEnvCliId(argv[index + 1]);
    }
    if (arg.startsWith("--cli=")) {
      return parseEnvCliId(arg.slice("--cli=".length));
    }
  }

  return undefined;
}

function parseEnvCliId(value: string | undefined): DedicatedCliId | undefined {
  if (!value) {
    return undefined;
  }

  if (value in DEFINITIONS) {
    return value as DedicatedCliId;
  }

  throw new Error(`Unsupported dedicated CLI "${value}". Expected one of: ${getDedicatedCliIds().join(", ")}`);
}
