import type { ClaudeSubagentDefinition, CodexSubagentRoleDefinition } from "@dotobokuri/fleet-carriers";

export type AgentCliId = "claude" | "codex";

export interface AgentCliProfile {
  readonly id: AgentCliId;
  readonly label: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
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

export interface AgentCliInjectionContext {
  readonly claudeSubagents?: readonly ClaudeSubagentDefinition[];
  readonly cliId: AgentCliId;
  readonly codexSubagents?: readonly AgentCliCodexSubagentRole[];
  readonly replaceSystemPrompt: boolean;
  readonly systemPromptFile: string;
  readonly mcpServers: readonly AgentCliMcpServerConfig[];
}

export interface AgentCliCodexSubagentRole {
  readonly definition: CodexSubagentRoleDefinition;
  readonly configFile: string;
}

export interface AgentCliMcpServerConfig {
  readonly name: string;
  readonly endpointUrl: string;
  readonly bearerToken: string;
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
