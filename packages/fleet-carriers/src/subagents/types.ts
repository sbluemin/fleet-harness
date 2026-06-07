import type { CarrierConfig } from "../dispatch/types.js";
export type { CarrierAgentProviderDefaults as ProviderSubagentDefaults } from "../dispatch/types.js";

export type NativeSubagentHost = "claude";

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

export interface BuildClaudeSubagentDefinitionsOptions {
  readonly carrierConfigs: readonly CarrierConfig[];
  readonly enabledCarrierIds: readonly string[];
}
