import type {
  CarrierCategory,
  FleetStoreSnapshot,
  TaskForceCliType,
} from "@sbluemin/fleet-admiral";

import type { FleetPtyApi } from "@sbluemin/fleet-tui/pty";

export type CarrierCliType = TaskForceCliType;
export type { FleetStoreSnapshot };

export interface CarrierStatusContext {
  readonly fleetPty: FleetPtyApi;
}

export interface ModelSelection {
  effort?: string;
  model: string;
}

export interface ModelEffort {
  readonly default?: string;
  readonly levels?: readonly string[];
  readonly supported: boolean;
}

export interface ProviderModelInfo {
  readonly modelId: string;
  readonly name: string;
}

export interface CliModelInfo {
  readonly [legacyField: string]: unknown;
  readonly defaultModel: string;
  readonly effort: ModelEffort;
  readonly models: ProviderModelInfo[];
  readonly name: string;
}

export interface ResolvedCliSelection {
  readonly effort: string | null;
  readonly isDefault: boolean;
  readonly model: string;
}

export interface CliTypeChangeResult {
  readonly carrierId: string;
  readonly newCliType: CarrierCliType;
  readonly selection: ResolvedCliSelection;
}

export interface CliTypeChangeSettledResult {
  readonly carrierId: string;
  readonly error?: string;
  readonly result?: CliTypeChangeResult;
  readonly status: "fulfilled" | "rejected";
}

export interface CarrierStatusEntry {
  carrierId: string;
  category?: CarrierCategory;
  cliType: CarrierCliType;
  defaultCliType: CarrierCliType;
  displayName: string;
  effort: string | null;
  isDefault: boolean;
  model: string;
  role: string | null;
  roleDescription: string | null;
  slot: number;
  taskForceBackendCount: number;
}

export interface CliTypeChoice {
  readonly label: string;
  readonly value: CarrierCliType;
}

export interface BatchCliChoice {
  readonly carrierCount: number;
  readonly cliType: CarrierCliType;
  readonly label: string;
}

export type OverlayState =
  | { readonly kind: "browse" }
  | { readonly carrierId: string; readonly choices: readonly string[]; readonly cursor: number; readonly kind: "model" }
  | { readonly carrierId: string; readonly choices: readonly string[]; readonly cursor: number; readonly kind: "effort"; readonly pendingModel: string }
  | { readonly carrierId: string; readonly choices: readonly CliTypeChoice[]; readonly cursor: number; readonly kind: "cliType" }
  | { readonly choices: readonly BatchCliChoice[]; readonly cursor: number; readonly kind: "batchFrom" }
  | { readonly choices: readonly BatchCliChoice[]; readonly cursor: number; readonly fromCli: CarrierCliType; readonly kind: "batchTo" }
  | { readonly kind: "saving" };

export interface TaskForceEntry {
  readonly cliType: TaskForceCliType;
  readonly color: string;
  readonly displayName: string;
  readonly effort: string | null;
  readonly isCustom: boolean;
  readonly model: string;
}
