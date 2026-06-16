import type { CliType } from "@dotobokuri/core-unified-agent";
import type { CarrierAgentMode } from "@dotobokuri/fleet-carriers";

export interface CarrierSettingsModelOption {
  readonly modelId: string;
  readonly name: string;
  readonly effort?: {
    readonly levels: readonly string[];
    readonly default: string;
  };
}

export interface CarrierSettingsCliOption {
  readonly id: CliType;
  readonly displayName: string;
  readonly supportsSubagent: boolean;
  readonly models: readonly CarrierSettingsModelOption[];
  readonly defaultModel: string;
}

export interface CarrierSettingsOptions {
  readonly cliTypes: readonly CarrierSettingsCliOption[];
  readonly taskForceConstraints: {
    readonly minBackends: number;
  };
}

export interface CarrierSettingsTaskForceBackend {
  readonly cliType: CliType;
  readonly model: string;
  readonly effort?: string;
}

export interface CarrierSettingsCarrier {
  readonly carrierId: string;
  readonly displayName: string;
  readonly sourceDisplayName: string;
  readonly role: string;
  readonly roleDescription: string;
  readonly category?: "strategy" | "planning" | "operations";
  readonly slot: number;
  readonly cliType: CliType;
  readonly defaultCliType: CliType;
  readonly model: string;
  readonly effort?: string;
  readonly agentMode: CarrierAgentMode;
  readonly subagentMode: boolean;
  readonly taskForceBackendCount: number;
  readonly taskforce: {
    readonly backends: readonly CarrierSettingsTaskForceBackend[];
  };
}

export interface CarrierSettingsState {
  readonly generation: number;
  readonly carriers: readonly CarrierSettingsCarrier[];
}

export interface CarrierSettingsMutationResult {
  readonly state: CarrierSettingsState;
}
