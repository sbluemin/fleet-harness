import { claudeCli } from "./claude/claude.js";
import { claudeKimiCli } from "./claude-kimi/claude-kimi.js";
import { codexCli } from "./codex/codex.js";
import type { AgentCliDefinition, AgentCliId, AgentCliProfile, AuthEnvResolver, AuthServiceLike } from "./types.js";

export interface ResolveAgentCliProfileOptions {
  readonly authEnvResolver?: AuthEnvResolver;
  readonly authService?: AuthServiceLike;
  readonly cliId?: string;
  readonly model?: string;
}

export interface AgentCliMetadata {
  readonly id: AgentCliId;
  readonly label: string;
  // 이 CLI가 지원하는 작전 이름 변경 슬래시 명령. 미지원이면 undefined.
  readonly renameCommand?: string;
}

const DEFAULT_CLI_ID: AgentCliId = "claude";
const DEFINITIONS: Record<AgentCliId, AgentCliDefinition> = {
  claude: claudeCli,
  "claude-kimi": claudeKimiCli,
  codex: codexCli,
};

export async function resolveAgentCliProfile(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: ResolveAgentCliProfileOptions = {},
): Promise<AgentCliProfile> {
  const id = resolveAgentCliId(env, options);
  return DEFINITIONS[id].createProfile({
    authEnvResolver: options.authEnvResolver,
    authService: options.authService,
    cwd,
    env,
    model: options.model,
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
    renameCommand: DEFINITIONS[id].renameCommand,
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
