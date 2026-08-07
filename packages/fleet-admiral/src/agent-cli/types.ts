import type { AdmiralDoctrine } from "../protocols/doctrine.js";
import type { ClaudeSkillOverride } from "./gateway-skills.js";

export type AgentCliId = "claude" | "claude-native" | "claude-gateway";

export interface AgentCliProfile {
  readonly id: AgentCliId;
  readonly label: string;
  readonly bin: string;
  // bin이 Windows .cmd shim을 cmd.exe로 래핑한 경우의 선행 인자(/d /s /c <shim>).
  readonly binPrefixArgs?: readonly string[];
  readonly args: readonly string[];
  readonly cleanup?: () => void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly launchWarnings?: readonly string[];
  readonly messagePolicy?: CliMessagePolicy;
  // 작전 이름 변경을 이 CLI 세션에 동기화하기 위해 PTY로 주입할 슬래시 명령(예: "/rename").
  // 슬래시 명령을 지원하지 않는 CLI(또는 FLEET_TERMINAL_CMD 등 임의 override)는 생략하며,
  // 그 경우 호스트는 rename 주입을 건너뛴다. messagePolicy와 동일하게 resolved profile에 실린다.
  readonly renameCommand?: string;
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
  readonly resumeSessionId?: string;
}

export interface AgentCliMcpServerArg {
  readonly bearerToken: string;
  readonly endpointUrl: string;
  readonly name: string;
}

export interface AgentCliInjectionContext {
  readonly cliId: AgentCliId;
  /**
   * Claude Code `--agents` JSON object. Gateway sessions inject AI Gateway
   * model/effort agents here without writing agent files.
   */
  readonly customAgents?: Readonly<Record<string, {
    readonly description: string;
    readonly prompt: string;
    readonly model: string;
    readonly effort?: string;
  }>>;
  /**
   * Claude Code `--settings`의 `skillOverrides` 맵. 세션이 싣지 않을 내장 스킬을
   * `off`로 넣는다. 프로세스 단위 필터라 서브에이전트 목록에도 함께 적용된다.
   */
  readonly skillOverrides?: Readonly<Record<string, ClaudeSkillOverride>>;
  readonly mcpServers: readonly AgentCliMcpServerArg[];
  readonly pluginRoot: string;
  readonly pluginRoots: readonly string[];
  readonly resumeSessionId?: string;
  readonly systemPromptFile?: string;
}

export interface AgentCliInjectionCapabilityEnabled {
  readonly enabled: true;
  readonly builderId: "claude-native";
}

export interface AgentCliInjectionCapabilityDisabled {
  readonly enabled: false;
  readonly reason: "native-builder-not-implemented";
}

export interface FleetHookExec {
  readonly args: readonly string[];
  readonly command: string;
}

export type AgentCliInjectionCapability =
  | AgentCliInjectionCapabilityEnabled
  | AgentCliInjectionCapabilityDisabled;

export interface AgentCliPluginMarketplaceLock {
  <T>(target: string, fn: () => T | Promise<T>): T | Promise<T>;
}

export interface CreateAgentCliPluginOptions {
  readonly captureSessionHookExec?: FleetHookExec;
  readonly cliId: string;
  readonly doctrine?: AdmiralDoctrine;
  readonly cwd: string;
  readonly dataDir?: string;
  // 턴 시작(UserPromptSubmit)·턴 종료(Stop) 신호를 호스트로 알리는 hook. host가 빌드해 주입한다.
  readonly turnStartHookExec?: FleetHookExec;
  readonly turnEndHookExec?: FleetHookExec;
  // 턴 종료(Stop)·서브에이전트 종료(SubagentStop) 시점에 살아 있는 백그라운드 작업 목록을 호스트로 보고하는 hook.
  readonly backgroundReportHookExec?: FleetHookExec;
  // 입력 대기(AskUserQuestion의 PreToolUse · permission/idle/elicitation Notification) 신호를 호스트로
  // 알리는 hook. AskUserQuestion은 Notification 훅을 발화하지 않으므로 두 이벤트 경로로 건다. Claude 전용.
  readonly inputWaitingHookExec?: FleetHookExec;
  // 작전명 자동 작명(UserPromptSubmit)을 위해 prompt를 호스트로 전달하는 hook.
  readonly autoNameHookExec?: FleetHookExec;
  readonly onCleanup?: (cleanup: () => void) => void;
  readonly rootDir?: string;
  readonly withMarketplaceLock: AgentCliPluginMarketplaceLock;
}

export interface AgentCliPlugin {
  readonly cleanup: () => void;
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

export interface MarketplaceTarget {
  readonly name: string;
  readonly root: string;
}

export interface RenderablePluginBundle {
  readonly bundle: PluginBundle;
  readonly target: MarketplaceTarget;
}

export type PluginBundle = AssetPluginBundle;
