import type { CarrierConfig } from "../dispatch/types.js";
import type { AgentCliSelection } from "../store/types.js";

export type { CarrierAgentProviderDefaults as ProviderSubagentDefaults } from "../dispatch/types.js";

export type NativeSubagentHost = "claude" | "codex";

export type ClaudeSubagentColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";

export interface ClaudeSubagentDefinition {
  readonly carrierId: string;
  readonly color?: ClaudeSubagentColor;
  readonly description: string;
  readonly effort?: string;
  readonly model?: string;
  readonly name: string;
  readonly prompt: string;
}

export interface CodexSubagentToml {
  readonly description: string;
  readonly model?: string;
  readonly model_instructions_file?: string;
  readonly model_reasoning_effort?: string;
  readonly name: string;
}

export interface CodexSubagentRoleDefinition {
  readonly carrierId: string;
  readonly description: string;
  readonly instructions: string;
  readonly roleKey: string;
  readonly toml: CodexSubagentToml;
}

export interface BuildClaudeSubagentDefinitionsOptions {
  readonly carrierConfigs: readonly CarrierConfig[];
  readonly enabledCarrierIds: readonly string[];
}

export interface BuildCodexSubagentDefinitionsOptions {
  readonly carrierConfigs: readonly CarrierConfig[];
  readonly enabledCarrierIds: readonly string[];
  readonly agentCliByCarrierId?: Readonly<Record<string, AgentCliSelection | undefined>>;
}
