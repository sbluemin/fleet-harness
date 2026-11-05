import process from "node:process";

import { createChildEnv, resolveBinary } from "@fleet-console/process";
import { prepareAiGatewayLaunchProfile, resolveAiGatewaySelection, visibleGatewayModels } from "@fleet-console/ai-gateway";
import type { AiGatewayStoredSettings, ProviderStatusMap } from "@fleet-console/ai-gateway";

import type { AiGatewayLaunchBinding } from "../agent/launch.js";
import { applyAgentCliPathEnvOverlay } from "../agent/agent-cli-paths.js";
import { stripConsoleInternalEnv, TERMINAL_TERM, withTerminalCapabilities } from "../terminal/launch-env.js";
import type { TerminalLaunchContext, TerminalLaunchSpec } from "../terminal/terminal-types.js";

/**
 * 독립 Claude Code CLI의 런치.
 *
 * 사령관도 지휘관도 아닌, AI Gateway만 바라보는 평범한 `claude`다. 그래서 Agent 런치(`agent/launch.ts`)가
 * 싣는 것 — Fleet MCP(`--mcp-config`)·Fleet 플러그인 트리·시스템 프롬프트·`--settings` 정책·세션 훅·
 * 세션 좌표 — 을 하나도 싣지 않는다. 인자는 비어 있고, 사용자 `~/.claude`의 설정·CLAUDE.md·스킬·
 * 플러그인·MCP와 Theater의 `.mcp.json`은 Claude Code가 평소대로 읽는다.
 *
 * 환경만 다르다: Gateway로 향하는 변수를 얹고, Console이 다른 Claude 세션 안에서 떴을 때 상속했을
 * Fleet·부모 세션의 표식과 자격은 걷는다. 그것을 남기면 이 CLI가 그 세션의 메시지 소켓·라우팅 Mod·
 * compact 훅 자격을 들고 Fleet의 일부처럼 행동한다.
 */
export interface StandaloneCliLaunchDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly aiGateway: AiGatewayLaunchBinding;
  readonly readAgentCliPaths?: () => Promise<Readonly<Record<string, string>>>;
  readonly readAiGatewaySettings?: () => AiGatewayStoredSettings;
  readonly readProviderStatuses?: () => ProviderStatusMap | undefined;
  /** Gateway 모델 캐시를 쓸 홈. 테스트만 넘긴다 — 생략하면 사용자 홈이다(Agent PTY와 같은 자리). */
  readonly homeDir?: string;
}

/**
 * 부모 Claude 세션이나 Fleet 세션에서 상속될 수 있는 이름들. 값이 있어도 이 CLI의 것이 아니다.
 * 사용자가 셸에서 직접 고른 Claude Code 설정(예: 자동 compact 창, 서브에이전트 깊이)은 여기 없다 — 그것은 남긴다.
 */
const INHERITED_SESSION_ENV_KEYS = [
  // Fleet 세션 식별·훅 자격. 이 CLI에는 Fleet 훅이 없다.
  "FLEET_CONSOLE_SESSION_ID",
  "FLEET_CONSOLE_AGENT_CALL_SESSION_ID",
  "FLEET_COMPACT_BASE_URL",
  "FLEET_COMPACT_HOOK_TOKEN",
  "FLEET_MOD_BASE_URL",
  "FLEET_MOD_TOKEN",
  // 부모 Claude 세션의 표식과 세션 간 메시지 통로. 남기면 이 CLI가 남의 세션의 자식으로 읽힌다.
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID",
] as const;

/** Gateway 런치 공용 변수 중 Fleet 라우팅 Mod를 싣는 스위치. 평범한 CLI는 사용자가 직접 켠 경우에만 받는다. */
const FUNCTION_HOOKS_ENV_KEY = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS";

export function standaloneCliBaseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = stripConsoleInternalEnv(env);
  for (const key of INHERITED_SESSION_ENV_KEYS) delete next[key];
  return next;
}

export function createStandaloneCliLaunchResolver(deps: StandaloneCliLaunchDeps) {
  return async (cwd: string | undefined, context: TerminalLaunchContext | undefined): Promise<TerminalLaunchSpec> => {
    if (!cwd) throw new Error("standalone_cli_cwd_required");
    const inherited = deps.env ?? process.env;
    let env = standaloneCliBaseEnv(inherited);
    if (deps.readAgentCliPaths) env = applyAgentCliPathEnvOverlay(env, "claude", await deps.readAgentCliPaths());
    const { bin, prefixArgs } = resolveBinary("claude", "CLAUDE_BIN", env);
    const origin = deps.aiGateway.origin();
    if (!origin) throw new Error("Fleet Console has not bound a port yet, so the AI gateway URL cannot be derived.");
    const baseEnv = withTerminalCapabilities({
      ...env,
      INIT_CWD: cwd,
      PWD: cwd,
      ...(context?.colorScheme ? { COLORFGBG: context.colorScheme === "light" ? "0;15" : "15;0" } : {}),
    });
    // Gateway 변수와 모델 캐시는 Agent PTY와 같은 한 함수가 같은 목록(로그인된 카탈로그)으로 정한다 — 같은 홈의
    // 캐시를 다른 목록으로 덮으면 그 홈을 쓰는 다른 자식의 별칭이 흔들린다. compact·Mod 자격은 넘기지 않는다.
    const selection = deps.readAiGatewaySettings ? resolveAiGatewaySelection(deps.readAiGatewaySettings()) : undefined;
    const profile = prepareAiGatewayLaunchProfile({
      id: "claude",
      label: "Claude Code",
      bin,
      args: [...prefixArgs],
      cwd,
      env: createChildEnv(baseEnv, {}),
      terminalName: TERMINAL_TERM,
    }, {
      baseUrl: `${origin}${deps.aiGateway.routePath}`,
      ...(selection ? { selection: { ...selection, models: visibleGatewayModels(readStatuses(deps.readProviderStatuses)) } } : {}),
      ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
    });
    const launchEnv: Record<string, string> = { ...profile.env };
    if (!inherited[FUNCTION_HOOKS_ENV_KEY]) delete launchEnv[FUNCTION_HOOKS_ENV_KEY];
    return { bin: profile.bin, args: [...profile.args], cwd, env: launchEnv, terminalName: TERMINAL_TERM };
  };
}

function readStatuses(read: (() => ProviderStatusMap | undefined) | undefined): ProviderStatusMap | undefined {
  if (!read) return undefined;
  try {
    return read();
  } catch {
    return undefined;
  }
}
