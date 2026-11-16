import { exposableEffortLadder, GATEWAY_REASONING_EFFORTS } from "@fleet-console/ai-gateway";
import type { GatewayModel, GatewayReasoningEffort } from "@fleet-console/ai-gateway";
import { OBJECTIVE_PEER_TOOLS, prepareClaudeSession, type AgentCliPlugin, type ClaudeSessionHandle, type ClaudeSessionOrigin } from "@fleet-console/agent-runtime/fleet";

import { buildConsoleHookEntry, buildConsoleWorkspaceHookCommand } from "./host-hooks.js";

/** AI gateway를 Console의 실제 listening origin에 연결하는 launch 바인딩. */
export interface AiGatewayLaunchBinding {
  /** Console 루트 기준 라우트 경로. 예: "/api/v1/ai-gateway" */
  readonly routePath: string;
  /** Console이 리슨 중인 origin. MCP는 별도 포트라 여기서 유도하면 안 된다. */
  origin(): string | null;
  /** Process-local credential accepted only by the compact lifecycle endpoint. */
  readonly compactHookToken?: string;
  /** 라우팅 Mod가 정체성을 물을 때 쓰는 자격. */
  readonly modHookToken?: string;
}

/** Chat Mode 세션을 열 때 넘기는 좌표 — PTY 런치와 공유하던 필드 가운데 채팅이 실제로 읽는 것만 남긴다. */
export interface ChatSessionPreparationDeps {
  readonly cwd: string;
  readonly entryPath?: string;
  readonly execPath?: string;
  readonly tsxLoaderPath?: string;
  /** 기동에 한 번 렌더해 둔 플러그인 트리. */
  readonly plugin: AgentCliPlugin;
  /** 사령관이 고른 플러그인의 로컬 디렉터리 — 그 사령관 목표의 세션이 새로 열릴 때 싣는다. */
  readonly pluginDirs?: readonly string[];
  /** 그 플러그인 MCP 선언의 `${VAR}`에 채울 키 — 같은 세션의 자식 환경에 얹는다. */
  readonly pluginEnv?: Readonly<Record<string, string>>;
  readonly origin: ClaudeSessionOrigin;
  readonly claudeCodeSystemPrompt?: "on" | "off";
  readonly claudeCodeDisabledAgents?: readonly string[];
  readonly disableAutoMemory?: boolean;
  readonly objectiveMessaging?: boolean;
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
    plugin: deps.plugin,
    ...(deps.pluginDirs?.length ? { pluginDirs: deps.pluginDirs } : {}),
    ...(deps.pluginEnv ? { pluginEnv: deps.pluginEnv } : {}),
    origin: deps.origin,
    ...(deps.claudeCodeSystemPrompt ? { claudeCodeSystemPrompt: deps.claudeCodeSystemPrompt } : {}),
    ...(deps.claudeCodeDisabledAgents ? { claudeCodeDisabledAgents: deps.claudeCodeDisabledAgents } : {}),
    ...(deps.disableAutoMemory !== undefined ? { disableAutoMemory: deps.disableAutoMemory } : {}),
    claudeCodeDisabledTools: consoleDisabledTools(deps.objectiveMessaging),
    workspaceHookExec: buildConsoleWorkspaceHookCommand(buildConsoleHookEntry(deps)),
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
