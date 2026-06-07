import type { ClaudeSubagentDefinition } from "@dotobokuri/fleet-carriers";

export interface FleetHookExec {
  readonly args: readonly string[];
  readonly command: string;
}

export interface CreateAgentCliPluginOptions {
  readonly assetsDir?: string;
  readonly claudeDefinitions: readonly ClaudeSubagentDefinition[];
  readonly cliId: string;
  readonly cwd: string;
  readonly hookExec?: FleetHookExec;
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

export interface PluginBundleBase {
  readonly description: string;
  readonly directoryName: string;
  readonly displayName: string;
  readonly hashFileName: string;
  readonly name: string;
}

export interface AssetPluginBundle extends PluginBundleBase {
  readonly includeClaudeAgents: boolean;
  readonly source: "asset";
}

export interface ProjectPluginBundle extends PluginBundleBase {
  readonly source: "project";
}

export interface GlobalPluginBundle extends PluginBundleBase {
  readonly source: "global";
}

export interface MarketplaceTarget {
  readonly name: string;
  readonly root: string;
}

export interface RenderablePluginBundle {
  readonly bundle: PluginBundle;
  readonly target: MarketplaceTarget;
}

export interface CopyDirectoryIntoPluginOptions {
  readonly label?: string;
  readonly required?: boolean;
  readonly followSymlinks?: boolean;
}

export type PluginBundle = AssetPluginBundle | ProjectPluginBundle | GlobalPluginBundle;

export type AssetEntry =
  | { readonly kind: "file"; readonly relativePath: string }
  | { readonly kind: "symlink"; readonly relativePath: string; readonly target: string };
