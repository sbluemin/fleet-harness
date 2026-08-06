import { claudeCli, claudeGatewayCli, claudeNativeCli } from "./claude/definitions.js";
import type { AgentCliDefinition, AgentCliId, AgentCliProfile } from "./types.js";

export interface ResolveAgentCliProfileOptions {
  readonly cliId?: string;
  readonly model?: string;
  readonly resumeSessionId?: string;
}

export interface AgentCliMetadata {
  readonly id: AgentCliId;
  readonly label: string;
}

const DEFAULT_CLI_ID: AgentCliId = "claude";
// Console 캔버스 제어 메뉴 순서를 고정한다: Claude (Native) → Claude → Claude (Gateway).
const DEFINITIONS: Record<AgentCliId, AgentCliDefinition> = {
  "claude-native": claudeNativeCli,
  claude: claudeCli,
  "claude-gateway": claudeGatewayCli,
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

// 기본 카탈로그 나열에서 제외하는 CLI. claude-native는 Console 전용이고, claude-gateway는
// 게이트웨이 라우트를 직접 마운트하는 호스트(Console 터미널 플러그인, fleet-cli thin 런처)가
// cliId를 명시해 해석한다 — 카탈로그 나열로는 노출하지 않는다.
const CONSOLE_ONLY_CLI_IDS: ReadonlySet<AgentCliId> = new Set<AgentCliId>(["claude-native", "claude-gateway"]);

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

  throw new Error(`Unsupported agent CLI "${value}". Expected one of: ${getAgentCliIds({ includeConsoleOnly: true }).join(", ")}`);
}
