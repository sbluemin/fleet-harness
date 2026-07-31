import type { GlobalOptionsData } from "@dotobokuri/core-infra";

import { claudeCli } from "./claude/claude.js";
import { claudeGatewayCli } from "./claude/claude-gateway.js";
import { claudeKimiCli } from "./claude/claude-kimi.js";
import { codexCli } from "./codex/codex.js";
import type { AgentCliDefinition, AgentCliId, AgentCliProfile, AuthServiceLike } from "./types.js";

export interface ResolveAgentCliProfileOptions {
  readonly authService?: AuthServiceLike;
  readonly cliId?: string;
  readonly globalOptionsService?: { load(): GlobalOptionsData };
  readonly model?: string;
  readonly resumeSessionId?: string;
}

export interface AgentCliMetadata {
  readonly id: AgentCliId;
  readonly label: string;
}

const DEFAULT_CLI_ID: AgentCliId = "claude";
const DEFINITIONS: Record<AgentCliId, AgentCliDefinition> = {
  claude: claudeCli,
  "claude-kimi": claudeKimiCli,
  "claude-gateway": claudeGatewayCli,
  codex: codexCli,
};

export async function resolveAgentCliProfile(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: ResolveAgentCliProfileOptions = {},
): Promise<AgentCliProfile> {
  const id = resolveAgentCliId(env, options);
  return DEFINITIONS[id].createProfile({
    authService: options.authService,
    cwd,
    env,
    globalOptionsService: options.globalOptionsService,
    model: options.model,
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

// Console 호스트에서만 성립하는 CLI. 게이트웨이 라우트가 Console에 마운트되어야 동작하므로
// 기본 카탈로그(예: Fleet CLI의 Start CLI 목록)에서는 제외한다.
const CONSOLE_ONLY_CLI_IDS: ReadonlySet<AgentCliId> = new Set<AgentCliId>(["claude-gateway"]);

export interface AgentCliIdListOptions {
  readonly includeConsoleOnly?: boolean;
}

export function getAgentCliIds(options: AgentCliIdListOptions = {}): AgentCliId[] {
  const ids = Object.keys(DEFINITIONS) as AgentCliId[];
  return options.includeConsoleOnly ? ids : ids.filter((id) => !CONSOLE_ONLY_CLI_IDS.has(id));
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
