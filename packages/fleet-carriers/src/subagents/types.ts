import type { CarrierConfig } from "../dispatch/types.js";

export interface ClaudeSubagentDefinition {
  readonly carrierId: string;
  readonly description: string;
  readonly model?: string;
  readonly name: string;
  readonly prompt: string;
}

export interface BuildClaudeSubagentDefinitionsOptions {
  readonly carrierConfigs: readonly CarrierConfig[];
  readonly enabledCarrierIds: readonly string[];
}
