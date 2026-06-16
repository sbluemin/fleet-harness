import type { ClaudeSubagentDefinition } from "@dotobokuri/fleet-carriers";

import type { CodexCommandResult, CodexPluginRegistrationCommand, FleetHookExec } from "../types.js";
export type { CodexCommandResult, CodexPluginRegistrationCommand } from "../types.js";

export interface AgentCliPluginMarketplaceLock {
  <T>(target: string, fn: () => T | Promise<T>): T | Promise<T>;
}

export interface CodexCommandRunner {
  (command: CodexPluginRegistrationCommand): CodexCommandResult;
}

export interface CreateAgentCliPluginOptions {
  readonly claudeDefinitions: readonly ClaudeSubagentDefinition[];
  readonly captureSessionHookExec?: FleetHookExec;
  readonly cliId: string;
  readonly codexCommandRunner?: CodexCommandRunner;
  readonly cwd: string;
  readonly dataDir: string;
  readonly hookExec?: FleetHookExec;
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
  readonly flat: boolean;
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
