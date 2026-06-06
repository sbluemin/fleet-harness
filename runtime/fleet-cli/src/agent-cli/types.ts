export type AgentCliId = "claude" | "claude-kimi" | "codex";

export interface AgentCliProfile {
  readonly id: AgentCliId;
  readonly label: string;
  readonly bin: string;
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
  readonly defaultBin: string;
  readonly envOverrideName: string;
  createProfile(options: AgentCliProfileOptions): Promise<AgentCliProfile>;
}

export interface AgentCliProfileOptions {
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
