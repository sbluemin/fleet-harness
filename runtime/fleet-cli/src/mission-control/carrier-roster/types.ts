import {
  CLI_DISPLAY_NAMES,
  type CarrierCategory,
  type CarrierCliType,
  type CarrierRuntime,
  type FleetStoreSnapshot,
  type ModelEffort,
  type TaskForceCliType,
} from "@dotobokuri/fleet-carriers";
import { getCliEffortLevels, getCliModels } from "@dotobokuri/core-agent";

import type { FleetPtyTheme } from "../../controls/index.js";

// 구조 동일 도메인 타입은 fleet-carriers(SSoT) 정의를 재export한다.
export type {
  CarrierCliType,
  CliTypeChangeResult,
  CliTypeChangeSettledResult,
  FleetStoreSnapshot,
  ModelEffort,
  ModelSelection,
  ResolvedCliSelection,
} from "@dotobokuri/fleet-carriers";

export interface ProviderModelInfo {
  readonly modelId: string;
  readonly name: string;
}

// host 확장 필드(effort/name)가 있어 fleet-carriers CliModelInfo와 분리 유지한다.
export interface CliModelInfo {
  readonly [legacyField: string]: unknown;
  readonly defaultModel: string;
  readonly effort: ModelEffort;
  readonly models: ProviderModelInfo[];
  readonly name: string;
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
  taskForceCapable: boolean;
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
  | { readonly cursor: number; readonly kind: "carrierActions" }
  | { readonly cursor: number; readonly kind: "rosterActions" }
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

export interface OpenTaskForcePanelOptions {
  readonly carrierDisplayName: string;
  readonly carrierId: string;
}

export interface CarrierStatusOverlayOptions {
  readonly carrierRuntime: CarrierRuntime;
  readonly done: () => void;
  readonly openTaskForcePanel: (options: OpenTaskForcePanelOptions) => void;
  readonly requestRender: () => void;
  readonly theme: FleetPtyTheme;
}

export interface EntrySnapshot {
  readonly cliType: CarrierCliType;
  readonly effort: string | null;
  readonly isDefault: boolean;
  readonly model: string;
}

export interface GroupedEntries {
  readonly color: string;
  readonly entries: CarrierStatusEntry[];
  readonly header: string;
}

export interface RenameState {
  readonly carrierId: string;
  readonly draft: string;
}

export interface StatusOverlayViewModel {
  readonly flatEntries: CarrierStatusEntry[];
  readonly groupedEntries: GroupedEntries[];
  readonly selectedCarrierId: string | null;
}

export type CarrierAction = "agent-cli" | "model" | "taskforce" | "rename" | "details";

const ACTION_LABELS: Readonly<Record<CarrierAction, string>> = {
  "agent-cli": "Agent CLI",
  model: "Model",
  taskforce: "Configure TaskForce",
  rename: "Rename Carrier",
  details: "Toggle Details",
};

export function getCarrierActions(entry: CarrierStatusEntry | null): readonly CarrierAction[] {
  if (!entry) return [];
  return entry.taskForceCapable
    ? ["agent-cli", "model", "taskforce", "rename", "details"]
    : ["agent-cli", "model", "rename", "details"];
}

export function getCarrierActionLabels(entry: CarrierStatusEntry | null): string[] {
  return getCarrierActions(entry).map((action) => ACTION_LABELS[action]);
}

export interface ModelEffortTransitionInput {
  readonly currentEffort: string | null;
  readonly effortChoices: readonly string[];
  readonly fallbackEffort: string | null;
  readonly selectedModel: string;
}

export type ModelEffortTransition =
  | { readonly kind: "commit"; readonly selection: { readonly effort?: string; readonly model: string } }
  | { readonly choices: readonly string[]; readonly cursor: number; readonly kind: "effort"; readonly pendingModel: string };

export function buildModelEffortTransition(input: ModelEffortTransitionInput): ModelEffortTransition {
  if (input.effortChoices.length === 0) {
    return {
      kind: "commit",
      selection: { model: input.selectedModel },
    };
  }

  const currentEffort = input.currentEffort && input.effortChoices.includes(input.currentEffort)
    ? input.currentEffort
    : input.fallbackEffort;
  const cursor = input.effortChoices.findIndex((level) => level === currentEffort);
  return {
    choices: input.effortChoices,
    cursor: Math.max(0, cursor),
    kind: "effort",
    pendingModel: input.selectedModel,
  };
}

/** core-agent 모델 조회를 carrier-roster의 CliModelInfo로 변환하는 단일 어댑터. */
export function getAvailableModels(cliType: CarrierCliType): CliModelInfo {
  const name = CLI_DISPLAY_NAMES[cliType] ?? cliType;
  try {
    const models = getCliModels(cliType).map((model) => ({
      modelId: model.id,
      name: model.name,
    }));
    const defaultModel = models[0]?.modelId ?? "default";
    return {
      defaultModel,
      effort: getModelEffort(cliType, defaultModel),
      models,
      name,
    };
  } catch {
    return {
      defaultModel: "default",
      effort: { supported: false },
      models: [],
      name,
    };
  }
}

/** CLI/모델 기준 effort 정보를 조회한다. 미지원·조회 실패 시 supported=false. */
export function getModelEffort(cliType: CarrierCliType, modelId: string): ModelEffort {
  try {
    const levels = getCliEffortLevels(cliType, modelId);
    if (!levels || levels.length === 0) return { supported: false };
    return {
      default: levels[0],
      levels,
      supported: true,
    };
  } catch {
    return { supported: false };
  }
}
