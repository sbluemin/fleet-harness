import { claudeCli } from "./claude/definitions.js";
import type { AgentCliDefinition, AgentCliId, AgentCliProfile } from "./types.js";

export interface ResolveAgentCliProfileOptions {
  readonly cliId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly prompt?: string;
  readonly resumeSessionId?: string;
}

export interface AgentCliMetadata {
  readonly id: AgentCliId;
  readonly label: string;
}

const DEFAULT_CLI_ID: AgentCliId = "claude";
const DEFINITIONS: Record<AgentCliId, AgentCliDefinition> = {
  "claude": claudeCli,
};

export async function resolveAgentCliProfile(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: ResolveAgentCliProfileOptions = {},
): Promise<AgentCliProfile> {
  const id = resolveAgentCliId(env, options);
  return DEFINITIONS[id].createProfile({
    cwd,
    env,
    model: options.model,
    effort: options.effort,
    prompt: options.prompt,
    resumeSessionId: options.resumeSessionId,
  });
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

  if (value === "claude-gateway" || value === "claude-native") return "claude";

  if (Object.hasOwn(DEFINITIONS, value)) {
    return value as AgentCliId;
  }

  throw new Error(`Unsupported agent CLI "${value}". Expected one of: ${getAgentCliIds().join(", ")}`);
}
