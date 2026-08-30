import type { GatewayEffortExposure, GatewayModel } from "@dotobokuri/core-ai-gateway";

import type { ClaudeSkillOverride } from "./gateway-skills.js";
import type { LaunchCommandLineLimit } from "./prompt.js";

export type AgentCliId = "claude";

export const MAX_LAUNCH_PROMPT_CHARS = 16000;

export interface AgentCliProfile {
  readonly id: AgentCliId;
  readonly label: string;
  readonly bin: string;
  // bin이 Windows .cmd shim을 cmd.exe로 래핑한 경우의 선행 인자(/d /s /c <shim>).
  readonly binPrefixArgs?: readonly string[];
  readonly args: readonly string[];
  // 이 실행에 걸리는 명령줄 상한. 프로필을 만든 쪽만 bin이 shim으로 감싸였는지 알고,
  // 최종 argv는 주입 계층에서야 완성되므로, 상한은 여기에 실어 그 계층까지 옮긴다.
  // POSIX 실행은 선언하지 않는다.
  readonly commandLineLimit?: LaunchCommandLineLimit;
  readonly cleanup?: () => void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly launchWarnings?: readonly string[];
  readonly messagePolicy?: CliMessagePolicy;
  // 작전 이름 변경을 이 CLI 세션에 동기화하기 위해 PTY로 주입할 슬래시 명령(예: "/rename").
  // 슬래시 명령을 지원하지 않는 CLI(또는 FLEET_TERMINAL_CMD 등 임의 override)는 생략하며,
  // 그 경우 호스트는 rename 주입을 건너뛴다. messagePolicy와 동일하게 resolved profile에 실린다.
  readonly renameCommand?: string;
  // 런치 프롬프트의 후미 위치(positional) 인자. `--mcp-config`는 가변 인자라 그 뒤에
  // 오는 위치 인자를 삼키므로, 최종 argv의 맨 끝에 남아야 한다. 주입 계층이 원문 대신
  // 임시 파일 지시를 실고, args 끝에 합친 뒤 비운다.
  readonly promptArgs?: readonly string[];
  readonly terminalName: string;
}

export interface CliMessagePolicy {
  readonly bracketedPaste?: boolean;
  readonly lineTerminator?: string;
  readonly multilineStrategy?: "literal" | "paste-mode";
}

export interface PtyInputChunk {
  readonly data: string;
  readonly submitDelayMs?: number;
}

export interface AgentCliDefinition {
  readonly id: AgentCliId;
  readonly label: string;
  createProfile(options: AgentCliProfileOptions): Promise<AgentCliProfile>;
}

export interface AgentCliProfileOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly model?: string;
  readonly effort?: string;
  readonly prompt?: string;
  readonly resumeSessionId?: string;
}

export interface AgentCliMcpServerArg {
  readonly bearerToken: string;
  readonly endpointUrl: string;
  readonly name: string;
}

/**
 * 못박힌 Claude 세션 좌표. argv 투영과 SDK 투영이 같은 값에서 나온다 —
 * 두 표면이 각자 이 좌표를 조립하면 한쪽만 정책 변경을 따라온다.
 */
export type ClaudeSessionCoordinate =
  | { readonly kind: "new"; readonly sessionId: string }
  | { readonly kind: "resume"; readonly sessionId: string }
  | { readonly kind: "fork"; readonly sessionId: string; readonly from: string }
  /**
   * 좌표를 호출자의 인자가 이미 들고 있다. Fleet은 세션 플래그를 하나도 싣지 않는다 —
   * `fleet --resume <id>`·`fleet -c`처럼 사용자가 직접 넘긴 경우다. `sessionId`는 이 런치의
   * 핸들 안에서 이 런치를 식별할 값일 뿐 Claude 세션 id가 아니다: 자식이 어떤 세션을 열지 우리는 모른다.
   */
  | { readonly kind: "external"; readonly sessionId: string };

export interface AgentCliInjectionContext {
  readonly cliId: AgentCliId;
  /**
   * Claude Code `--settings`의 `skillOverrides` 맵. 세션이 싣지 않을 내장 스킬을
   * `off`로 넣는다. 프로세스 단위 필터라 서브에이전트 목록에도 함께 적용된다.
   */
  readonly skillOverrides?: Readonly<Record<string, ClaudeSkillOverride>>;
  readonly mcpServers: readonly AgentCliMcpServerArg[];
  readonly pluginRoot: string;
  readonly pluginRoots: readonly string[];
  readonly sessionCoordinate: ClaudeSessionCoordinate;
  /**
   * Claude Code 자신의 기본 시스템 프롬프트를 이 세션에 실을지. 생략은 `on`이며 플래그가
   * 붙지 않는다. `off`는 빈 본문을 시스템 프롬프트로 세워 그것을 대체한다 —
   * 실측(2.1.235, haiku): 턴당 총 입력 토큰 26,036 → 19,546.
   */
  readonly claudeCodeSystemPrompt?: "on" | "off";
  /**
   * 이 런치가 Claude Code의 승인 게이트를 건너뛸지. 생략은 `false`이며 플래그가 붙지 않는다 —
   * 그때 자식은 자기 기본 권한 모드로 떠서 도구마다 터미널에서 승인을 묻는다.
   *
   * 이 축은 argv 표면에만 있다. SDK 표면(Chat Mode)은 값과 무관하게 bypass로 남는데,
   * 그 이유는 `session.ts`의 `permissionMode` 옆에 적혀 있다.
   */
  readonly claudeCodeSkipPermissions?: boolean;
}

export interface AgentCliInjectionCapabilityEnabled {
  readonly enabled: true;
  readonly builderId: "claude";
}

export interface FleetHookExec {
  readonly args: readonly string[];
  readonly command: string;
}

export type AgentCliInjectionCapability = AgentCliInjectionCapabilityEnabled;

export interface CreateAgentCliPluginOptions {
  readonly captureSessionHookExec?: FleetHookExec;
  readonly cliId: string;
  readonly cwd: string;
  readonly dataDir?: string;
  // 턴 시작(UserPromptSubmit)·턴 종료(Stop) 신호를 호스트로 알리는 hook. host가 빌드해 주입한다.
  readonly turnStartHookExec?: FleetHookExec;
  readonly turnEndHookExec?: FleetHookExec;
  // 서브에이전트 종료(SubagentStop) 시점에 살아 있는 백그라운드 작업 목록을 호스트로 보고하는 hook.
  // 턴 종료(Stop) 시점의 같은 보고는 turnEndHookExec이 함께 실어 나른다.
  readonly backgroundReportHookExec?: FleetHookExec;
  // 입력 대기(AskUserQuestion의 PreToolUse · permission/idle/elicitation Notification) 신호를 호스트로
  // 알리는 hook. AskUserQuestion은 Notification 훅을 발화하지 않으므로 두 이벤트 경로로 건다. Claude 전용.
  readonly inputWaitingHookExec?: FleetHookExec;
  // 작전명 자동 작명(UserPromptSubmit)을 위해 prompt를 호스트로 전달하는 hook.
  readonly autoNameHookExec?: FleetHookExec;
  // 위임 정체성으로 등록할 gateway 모델과 강도. 사용자가 노출한 집합에서 host 전용 모델을 뺀
  // 목록이며, `selection.models`를 넘기는 버그를 막기 위해 이름에 delegation을 명시한다.
  // claude-gateway 렌더만 읽어 `agents/` 정의를 만든다.
  readonly gatewayDelegationModels?: readonly GatewayModel[];
  readonly gatewayEffortExposure?: GatewayEffortExposure;
  /** 테스트가 레거시 트리 회수의 시계와 나이 창을 갈아 끼우는 자리. 프로덕션은 비워 둔다. */
  readonly legacyReclaimDeps?: LegacyMarketplaceReclaimDeps;
}

export interface LegacyMarketplaceReclaimDeps {
  readonly now?: () => number;
  readonly staleAfterMs?: number;
}

export interface AgentCliPlugin {
  readonly pluginRoot: string;
  readonly pluginRoots: readonly string[];
}

export interface PluginBundleBase {
  readonly description: string;
  readonly directoryName: string;
  readonly displayName: string;
  readonly name: string;
}

export interface AssetPluginBundle extends PluginBundleBase {
  readonly source: "asset";
}

export type PluginBundle = AssetPluginBundle;
