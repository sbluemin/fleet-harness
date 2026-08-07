import { claudeGatewayCli, claudeNativeCli } from "./claude/definitions.js";
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

const DEFAULT_CLI_ID: AgentCliId = "claude-gateway";
// Console 캔버스 제어 메뉴 순서를 고정한다: Claude (Native) → Claude (Gateway).
const DEFINITIONS: Record<AgentCliId, AgentCliDefinition> = {
  "claude-native": claudeNativeCli,
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

  // 퇴역한 Classic id는 최소 한 릴리스 동안 gateway로 정규화한다. 이미 FLEET_AGENT_CLI=claude를
  // 내보내 둔 환경이 업그레이드만으로 기동 불능이 되지 않게 한다.
  if (value === RETIRED_CLASSIC_CLI_ID) {
    return "claude-gateway";
  }

  if (Object.hasOwn(DEFINITIONS, value)) {
    return value as AgentCliId;
  }

  throw new Error(`Unsupported agent CLI "${value}". Expected one of: ${getAgentCliIds().join(", ")}`);
}

/** 퇴역한 Classic Agent CLI id. 값 자체는 더 이상 해석되지 않고 gateway로 정규화된다. */
const RETIRED_CLASSIC_CLI_ID = "claude";
