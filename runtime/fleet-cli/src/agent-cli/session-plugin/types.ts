import type { ClaudeSubagentDefinition } from "@dotobokuri/fleet-carriers";

export interface SessionPluginMcpServerInput {
  readonly endpointUrl: string;
  readonly name: string;
  readonly token: string;
}

export interface CreateAgentCliSessionPluginOptions {
  readonly claudeDefinitions: readonly ClaudeSubagentDefinition[];
  readonly cliId: string;
  readonly cwd: string;
  readonly doctrine: string;
  readonly mcpServers: readonly SessionPluginMcpServerInput[];
  readonly onCleanup?: (cleanup: () => void) => void;
  readonly rootDir?: string;
}

export interface CodexPluginRegistration {
  readonly contentHash: string;
  readonly hashPath: string;
  readonly marketplaceDir: string;
  readonly marketplaceName: string;
  readonly pluginName: string;
  readonly pluginRoot: string;
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

export interface AgentCliSessionPlugin {
  readonly cleanup: () => void;
  readonly codexRegistration?: CodexPluginRegistration;
  readonly env: Readonly<Record<string, string>>;
  readonly pluginRoot: string;
}
