import type { AuthService } from "@dotobokuri/fleet-infra/auth";

export type AgentCliId = "claude" | "claude-kimi" | "codex";

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
  readonly terminalName: string;
}

export interface CliMessagePolicy {
  readonly bracketedPaste?: boolean;
  readonly lineTerminator?: string;
  readonly multilineStrategy?: "literal" | "paste-mode";
}

export interface AgentCliDefinition {
  readonly id: AgentCliId;
  readonly label: string;
  createProfile(options: AgentCliProfileOptions): Promise<AgentCliProfile>;
}

export interface AgentCliProfileOptions {
  // Composition Root가 주입하는 인증 서비스 — 미주입 시 fleet-infra 기본 경로로 fallback한다.
  readonly authService?: AuthService;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly model?: string;
}

export interface AgentCliMcpServerArg {
  readonly bearerToken: string;
  readonly endpointUrl: string;
  readonly name: string;
}

export interface AgentCliInjectionContext {
  readonly cliId: AgentCliId;
  readonly codexProfileName?: string;
  readonly mcpServers: readonly AgentCliMcpServerArg[];
  readonly pluginRoot: string;
  readonly pluginRoots: readonly string[];
  readonly replaceSystemPrompt?: boolean;
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

export type AgentCliInjectionCapability =
  | AgentCliInjectionCapabilityEnabled
  | AgentCliInjectionCapabilityDisabled;
