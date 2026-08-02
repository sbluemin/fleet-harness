import type { AdmiralDoctrine } from "../protocols/doctrine.js";

export type AgentCliId = "claude" | "claude-native" | "claude-gateway" | "codex";

export interface AgentCliProfile {
  readonly id: AgentCliId;
  readonly label: string;
  readonly bin: string;
  // bin이 Windows .cmd shim을 cmd.exe로 래핑한 경우의 선행 인자(/d /s /c <shim>).
  // PTY 외 경로(예: Codex 플러그인 등록)에서 bin과 함께 재사용해 동일하게 CLI를 호출한다.
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
  // true면 Windows(win32)에서 crossterm/ConPTY paste-burst 우회를 적용: bracketed paste 마커 없이 순수 텍스트를 보낸 뒤 제출 CR을 지연된 별도 write로 분리한다. Codex 계열 crossterm TUI 전용.
  readonly conptyPasteBurst?: boolean;
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
  readonly codexProfileName?: string;
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
  readonly mcpServers: readonly AgentCliMcpServerArg[];
  readonly pluginRoot: string;
  readonly pluginRoots: readonly string[];
  readonly resumeSessionId?: string;
  readonly systemPromptFile?: string;
}

export interface AgentCliInjectionCapabilityEnabled {
  readonly enabled: true;
  readonly builderId: "claude-native" | "codex-native";
}

export interface AgentCliInjectionCapabilityDisabled {
  readonly enabled: false;
  readonly reason: "native-builder-not-implemented";
}

export interface FleetHookExec {
  readonly args: readonly string[];
  readonly command: string;
}

export interface CodexCommandResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface CodexPluginRegistrationCommand {
  readonly args: readonly string[];
  readonly bin: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type AgentCliInjectionCapability =
  | AgentCliInjectionCapabilityEnabled
  | AgentCliInjectionCapabilityDisabled;

export interface AgentCliPluginMarketplaceLock {
  <T>(target: string, fn: () => T | Promise<T>): T | Promise<T>;
}

export interface CodexCommandRunner {
  (command: CodexPluginRegistrationCommand): CodexCommandResult;
}

export interface CreateAgentCliPluginOptions {
  readonly captureSessionHookExec?: FleetHookExec;
  readonly cliId: string;
  readonly doctrine?: AdmiralDoctrine;
  readonly codexCommandRunner?: CodexCommandRunner;
  readonly cwd: string;
  readonly dataDir?: string;
  // 턴 시작(UserPromptSubmit)·턴 종료(Stop) 신호를 호스트로 알리는 hook. host가 빌드해 주입한다.
  readonly turnStartHookExec?: FleetHookExec;
  readonly turnEndHookExec?: FleetHookExec;
  // 입력 대기(AskUserQuestion의 PreToolUse · permission/idle/elicitation Notification) 신호를 호스트로
  // 알리는 hook. AskUserQuestion은 Notification 훅을 발화하지 않으므로 두 이벤트 경로로 건다. Claude 전용.
  readonly inputWaitingHookExec?: FleetHookExec;
  // 작전명 자동 작명(UserPromptSubmit)을 위해 prompt를 호스트로 전달하는 hook. Claude/Codex 양쪽에 와이어링된다.
  readonly autoNameHookExec?: FleetHookExec;
  readonly onCleanup?: (cleanup: () => void) => void;
  readonly rootDir?: string;
  readonly withMarketplaceLock: AgentCliPluginMarketplaceLock;
}

export interface CodexPluginRegistration {
  readonly contentHash: string;
  readonly hashPath: string;
  readonly marketplaceDir: string;
  readonly marketplaceName: string;
  readonly pluginName: string;
  readonly pluginRoot: string;
}

export interface AgentCliPlugin {
  readonly cleanup: () => void;
  readonly codexRegistrations: readonly CodexPluginRegistration[];
  readonly pluginRoot: string;
  readonly pluginRoots: readonly string[];
}

export interface PluginBundleBase {
  readonly description: string;
  readonly directoryName: string;
  readonly displayName: string;
  readonly hashFileName: string;
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
