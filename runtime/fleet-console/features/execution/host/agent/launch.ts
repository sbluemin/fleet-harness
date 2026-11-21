import { exposableEffortLadder, GATEWAY_REASONING_EFFORTS } from "@fleet-console/ai-gateway";
import type { GatewayModel, GatewayReasoningEffort } from "@fleet-console/ai-gateway";
import type { ClaudeGatewayEffort } from "@fleet-console/agent-runtime/claude";
import { NATIVE_CLAUDE_EFFORTS, OBJECTIVE_PEER_TOOLS, prepareClaudeSession, type ClaudeSessionHandle, type PrepareClaudeSessionOptions } from "@fleet-console/agent-runtime/fleet";

/** AI gateway를 Console의 실제 listening origin에 연결하는 launch 바인딩. */
export interface AiGatewayLaunchBinding {
  /** Console 루트 기준 라우트 경로. 예: "/api/v1/ai-gateway" */
  readonly routePath: string;
  /** Console이 리슨 중인 origin. MCP는 별도 포트라 여기서 유도하면 안 된다. */
  origin(): string | null;
}

/**
 * Chat Mode 세션을 열 때 넘기는 좌표 — admiral의 세션 옵션 가운데 채팅이 실제로 읽어 넘기는 것만 고른다.
 * CLI 식별자와 도구 목록은 여기서 정책으로 채운다. 옵션에 필드가 늘어도 채팅이 넘기기 전까지는 받지 않는다.
 */
export type ChatSessionPreparationDeps = Pick<PrepareClaudeSessionOptions, "cwd" | "origin" | "pluginDirs" | "pluginEnv" | "claudeCodeSystemPrompt" | "claudeCodeDisabledAgents" | "disableAutoMemory"> & {
  /** 목표 세션(지휘관·구성원)이면 피어 도구를 더 뺀다. */
  readonly objectiveMessaging?: boolean;
};

/**
 * 새 세션 트랙의 launch 설정을 Chat Mode SDK 시드로 옮긴다.
 */
export type ChatLaunchEffortResolution = {
  readonly effort: ClaudeGatewayEffort;
};

export function resolveChatLaunchEffort(value: string): ChatLaunchEffortResolution | undefined {
  if (value.length === 0) return undefined;
  return (NATIVE_CLAUDE_EFFORTS as readonly string[]).includes(value)
    ? { effort: value as ClaudeGatewayEffort }
    : undefined;
}

export function isGatewayLaunchEffortAllowed(
  model: GatewayModel,
  effort: string,
): boolean {
  if (!(GATEWAY_REASONING_EFFORTS as readonly string[]).includes(effort)) return false;
  return exposableEffortLadder(model).includes(effort as GatewayReasoningEffort);
}

/**
 * Chat Mode 세션이 SDK에 넘길 Claude 세션 핸들을 admiral에서 받는다.
 *
 * 여기서 조립하는 것은 아무것도 없다 — 세션 id, 플러그인 트리, 스킬 억제, 설정 층, 시스템
 * 프롬프트 정책은 전부 핸들이 들고 온다. 반환된 핸들의 `release`를 세션 teardown에 연결하지 않으면
 * 트리가 회수되지 않는다.
 */
export async function prepareChatClaudeSession(
  deps: ChatSessionPreparationDeps,
): Promise<ClaudeSessionHandle> {
  return prepareClaudeSession({
    cliId: CHAT_PLUGIN_CLI_ID,
    cwd: deps.cwd,
    ...(deps.pluginDirs?.length ? { pluginDirs: deps.pluginDirs } : {}),
    ...(deps.pluginEnv ? { pluginEnv: deps.pluginEnv } : {}),
    origin: deps.origin,
    ...(deps.claudeCodeSystemPrompt ? { claudeCodeSystemPrompt: deps.claudeCodeSystemPrompt } : {}),
    ...(deps.claudeCodeDisabledAgents ? { claudeCodeDisabledAgents: deps.claudeCodeDisabledAgents } : {}),
    ...(deps.disableAutoMemory !== undefined ? { disableAutoMemory: deps.disableAutoMemory } : {}),
    claudeCodeDisabledTools: consoleDisabledTools(deps.objectiveMessaging),
  });
}

const CHAT_PLUGIN_CLI_ID = "claude";
/**
 * Console이 띄우는 Claude 세션이 늘 빼는 대화형 도구 — 사람에게 묻는 질문, 계획 모드 진입과 계획 승인.
 * 진입만 남기면 승인 없이 계획 모드를 빠져나올 수 없으므로 함께 뺀다.
 */
export const CONSOLE_DISABLED_TOOLS: readonly string[] = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];
/** 목표 세션만 피어 도구를 더 뺀다. 그 밖은 기존 목록 그대로다. */
export function consoleDisabledTools(objectiveMessaging: boolean | undefined): readonly string[] {
  return objectiveMessaging ? [...CONSOLE_DISABLED_TOOLS, ...OBJECTIVE_PEER_TOOLS] : CONSOLE_DISABLED_TOOLS;
}
