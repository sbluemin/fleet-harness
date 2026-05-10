import type { HealthStatus, ProviderKey } from "@sbluemin/fleet-unified-agent";
import type { CarrierCategory } from "./types.js";

export type CarrierCliType = ProviderKey;

export interface ModelSelection {
  model: string;
  effort?: string;
}

export interface ModelEffort {
  supported: boolean;
  levels?: readonly string[];
  default?: string;
}

export interface ModelInfo {
  modelId: string;
  name: string;
  effort?: ModelEffort;
}

export interface CliModelInfo {
  readonly [legacyField: string]: unknown;
  defaultModel: string;
  models: ModelInfo[];
}

export interface CliServiceSnapshot {
  status: HealthStatus;
}

export interface ResolvedCliSelection {
  model: string;
  effort: string | null;
  isDefault: boolean;
}

export interface CliTypeChangeResult {
  carrierId: string;
  newCliType: CarrierCliType;
  selection: ResolvedCliSelection;
}

export interface CliTypeChangeSettledResult {
  status: "fulfilled" | "rejected";
  carrierId: string;
  result?: CliTypeChangeResult;
  error?: string;
}

export interface CarrierStatusEntry {
  carrierId: string;
  slot: number;
  cliType: CarrierCliType;
  defaultCliType: CarrierCliType;
  displayName: string;
  model: string;
  isDefault: boolean;
  effort: string | null;
  role: string | null;
  roleDescription: string | null;
  isSortieEnabled: boolean;
  isSquadronEnabled: boolean;
  taskForceBackendCount: number;
  category?: CarrierCategory;
}

export interface CarrierStatusGroup {
  header: string;
  color: string;
  providerKey: ProviderKey;
  entries: CarrierStatusEntry[];
}

export interface CliTypeChoice {
  value: CarrierCliType;
  label: string;
}

export interface BatchCliChoice {
  cliType: CarrierCliType;
  label: string;
  carrierCount: number;
  status: HealthStatus;
}

export type OverlayState =
  | { kind: "browse" }
  | { kind: "model"; carrierId: string; choices: string[]; cursor: number }
  | { kind: "effort"; carrierId: string; pendingModel: string; choices: string[]; cursor: number }
  | { kind: "cliType"; carrierId: string; choices: CliTypeChoice[]; cursor: number }
  | { kind: "batchFrom"; choices: BatchCliChoice[]; cursor: number }
  | { kind: "batchTo"; fromCli: CarrierCliType; choices: BatchCliChoice[]; cursor: number }
  | { kind: "saving" };

export interface CarrierOverlayCallbacks {
  getEntries(): CarrierStatusEntry[];
  changeCliType(carrierId: string, newCliType: CarrierCliType): Promise<ResolvedCliSelection>;
  changeCliTypes(updates: Array<{ carrierId: string; newCliType: CarrierCliType }>): Promise<CliTypeChangeSettledResult[]>;
  resetCliTypesToDefault(): Promise<CliTypeChangeSettledResult[]>;
  saveModelSelection(carrierId: string, selection: ModelSelection): Promise<void>;
  toggleSortieEnabled(carrierId: string): void;
  toggleSquadronEnabled(carrierId: string): void;
  openTaskForce(carrierId: string): void;
  getAvailableModels(cliType: CarrierCliType): CliModelInfo;
  getServiceSnapshots(): Map<CarrierCliType, CliServiceSnapshot>;
  getDefaultCliType(): CarrierCliType;
}
