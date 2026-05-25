import { claudeCli } from "./claude/claude.js";
import { claudeKimiCli } from "./claude-kimi/claude-kimi.js";
import { claudeZaiCli } from "./claude-zai/claude-zai.js";
import { codexCli } from "./codex/codex.js";
import type { AgentCliDefinition, AgentCliId, AgentCliProfile } from "./types.js";

interface ResolveAgentCliProfileOptions {
  readonly cliId?: string;
  readonly model?: string;
}

export interface AgentCliMetadata {
  readonly id: AgentCliId;
  readonly label: string;
}

const DEFAULT_CLI_ID: AgentCliId = "claude";
const DEFINITIONS: Record<AgentCliId, AgentCliDefinition> = {
  claude: claudeCli,
  "claude-zai": claudeZaiCli,
  "claude-kimi": claudeKimiCli,
  codex: codexCli,
};

export async function resolveAgentCliProfile(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: ResolveAgentCliProfileOptions = {},
): Promise<AgentCliProfile> {
  const id = resolveAgentCliId(env, options);
  return DEFINITIONS[id].createProfile({ cwd, env, model: options.model });
}

export function resolveAgentCliId(env: NodeJS.ProcessEnv, options: ResolveAgentCliProfileOptions = {}): AgentCliId {
  return parseEnvCliId(options.cliId) ?? parseEnvCliId(env.FLEET_AGENT_CLI) ?? DEFAULT_CLI_ID;
}

export function parseAgentCliId(value: string | undefined): AgentCliId | undefined {
  return parseEnvCliId(value);
}

export function getDefaultAgentCliId(): AgentCliId {
  return DEFAULT_CLI_ID;
}

export function getAgentCliIds(): AgentCliId[] {
  return Object.keys(DEFINITIONS) as AgentCliId[];
}

export function getAgentCliMetadata(ids: readonly AgentCliId[] = getAgentCliIds()): AgentCliMetadata[] {
  return ids.map((id) => ({
    id,
    label: DEFINITIONS[id].label,
  }));
}

function parseEnvCliId(value: string | undefined): AgentCliId | undefined {
  if (!value) {
    return undefined;
  }

  if (Object.hasOwn(DEFINITIONS, value)) {
    return value as AgentCliId;
  }

  throw new Error(`Unsupported agent CLI "${value}". Expected one of: ${getAgentCliIds().join(", ")}`);
}
