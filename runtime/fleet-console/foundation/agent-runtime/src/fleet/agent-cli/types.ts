/** 이 세션이 들고 가는 게이트웨이 정체성의 등록 이름. */
export const FLEET_PLUGIN_NAME = "fleet";

import type { IncomingMessage, ServerResponse } from "node:http";

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
  // 목표 이름 변경을 이 CLI 세션에 동기화하기 위해 PTY로 주입할 슬래시 명령(예: "/rename").
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
  /** CLI 세션의 표시 이름 — 세션 목록·터미널 제목·세션 간 메시지 주소가 된다(Claude 계열 `-n`). */
  readonly sessionName?: string;
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
  readonly additionalDirectories?: readonly string[];
  /** 함께 실을 로컬 플러그인 디렉터리 — `--plugin-dir`로 하나씩 싣는다. */
  readonly pluginDirs?: readonly string[];
  readonly cliId: AgentCliId;
  /**
   * Claude Code `--settings`의 `skillOverrides` 맵. 세션이 싣지 않을 내장 스킬을
   * `off`로 넣는다. 프로세스 단위 필터라 서브에이전트 목록에도 함께 적용된다.
   */
  readonly skillOverrides?: Readonly<Record<string, ClaudeSkillOverride>>;
  readonly mcpServers: readonly AgentCliMcpServerArg[];
  readonly sessionCoordinate: ClaudeSessionCoordinate;
  /**
   * 이 세션에 Claude Code 기본 시스템 프롬프트를 실을지. 생략은 `on`이며 플래그가 붙지 않는다.
   * `off`는 빈 본문을 세워 기본 프롬프트를 대체한다 —
   * 실측(2.1.235, haiku): 턴당 총 입력 토큰 26,036 → 19,546.
   */
  readonly claudeCodeSystemPrompt?: "on" | "off";
  /**
   * Claude Code 내장 서브에이전트 중 이 세션에서 끌 이름들. 각 이름이 `Agent(<name>)` deny
   * 규칙 하나가 되어 `--settings`의 `permissions.deny`로 실린다. 생략·빈 목록은 규칙을 싣지
   * 않는다 — 플래그 없는 런치가 이미 하는 일이다.
   */
  readonly claudeCodeDisabledAgents?: readonly string[];
  /** 이 세션에서 뺄 도구 이름들(예: `AskUserQuestion`). 서브에이전트 규칙과 합쳐 같은 `permissions.deny`로 실린다. */
  readonly claudeCodeDisabledTools?: readonly string[];
  /** 명시하면 auto-memory를 고정한다(true=끔, false=켬). 생략은 사용자 설정을 따른다. */
  readonly disableAutoMemory?: boolean;
}

export interface AgentCliInjectionCapabilityEnabled {
  readonly enabled: true;
  readonly builderId: "claude";
}

export type AgentCliInjectionCapability = AgentCliInjectionCapabilityEnabled;
