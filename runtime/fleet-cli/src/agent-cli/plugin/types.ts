import type { ClaudeSubagentDefinition } from "@dotobokuri/fleet-carriers";

export interface CreateAgentCliPluginOptions {
  readonly assetsDir?: string;
  readonly claudeDefinitions: readonly ClaudeSubagentDefinition[];
  readonly cliId: string;
  readonly cwd: string;
  readonly hookCommand?: string;
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

export interface AgentCliPlugin {
  readonly cleanup: () => void;
  readonly codexRegistrations: readonly CodexPluginRegistration[];
  readonly pluginRoot: string;
  readonly pluginRoots: readonly string[];
}
