import { claudeCli } from "./claude/claude.js";
import { claudeKimiCli } from "./claude-kimi/claude-kimi.js";
import { claudeZaiCli } from "./claude-zai/claude-zai.js";
import { codexCli } from "./codex/codex.js";
import type { DedicatedCliDefinition, DedicatedCliId, DedicatedCliProfile } from "./types.js";

interface ResolveDedicatedCliProfileOptions {
  readonly cliId?: string;
  readonly model?: string;
}

export interface DedicatedCliMetadata {
  readonly id: DedicatedCliId;
  readonly label: string;
}

const DEFAULT_CLI_ID: DedicatedCliId = "claude";
const DEFINITIONS: Record<DedicatedCliId, DedicatedCliDefinition> = {
  claude: claudeCli,
  "claude-zai": claudeZaiCli,
  "claude-kimi": claudeKimiCli,
  codex: codexCli,
};

export async function resolveDedicatedCliProfile(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: ResolveDedicatedCliProfileOptions = {},
): Promise<DedicatedCliProfile> {
  const id = resolveDedicatedCliId(env, options);
  return DEFINITIONS[id].createProfile({ cwd, env, model: options.model });
}

export function resolveDedicatedCliId(env: NodeJS.ProcessEnv, options: ResolveDedicatedCliProfileOptions = {}): DedicatedCliId {
  return parseEnvCliId(options.cliId) ?? parseEnvCliId(env.FLEET_DEDICATED_CLI) ?? DEFAULT_CLI_ID;
}

export function getDedicatedCliIds(): DedicatedCliId[] {
  return Object.keys(DEFINITIONS) as DedicatedCliId[];
}

export function getDedicatedCliMetadata(ids: readonly DedicatedCliId[] = getDedicatedCliIds()): DedicatedCliMetadata[] {
  return ids.map((id) => ({
    id,
    label: DEFINITIONS[id].label,
  }));
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
