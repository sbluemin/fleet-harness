import {
  getEffort,
  getProviderModels,
  type CliType,
} from "@dotobokuri/fleet-unified-agent";
import { TASKFORCE_CLI_TYPES, type TaskForceCliType } from "../dispatch/types.js";
import { loadModels } from "./models.js";
import { updateStates } from "./state-io.js";
import type {
  FleetStoreSnapshot,
  ModelSelection,
  SelectedModelsConfig,
  TaskForceConfig,
  TaskForceSelection,
} from "./types.js";

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Task Force 백엔드별 모델 설정을 반환합니다.
 * 명시적 설정이 없으면 undefined를 반환합니다 (auto 폴백 없음).
 */
export function getTaskForceModelConfig(
  carrierId: string,
  cliType: string,
  snapshot?: FleetStoreSnapshot,
): TaskForceSelection | undefined {
  const resolvedCliType = toTaskForceCliType(cliType);
  const config = snapshot?.models ? sanitizeSelectedModelsConfig(snapshot.models) : loadModels();
  const taskforceConfig = getSanitizedTaskForceConfig(config, carrierId);
  return taskforceConfig?.[resolvedCliType];
}

/**
 * Task Force 백엔드별 모델 설정을 저장합니다.
 */
export function updateTaskForceModelSelection(
  carrierId: string,
  cliType: string,
  selection: TaskForceSelection,
): void {
  const resolvedCliType = toTaskForceCliType(cliType);
  const sanitizedSelection = sanitizeTaskForceSelection(resolvedCliType, selection);
  if (!sanitizedSelection) {
    throw new Error(`Invalid Task Force model selection for ${resolvedCliType}.`);
  }

  updateStates((states) => {
    const models = sanitizeSelectedModelsConfig(states.models);
    ensureTaskForceConfig(models, carrierId)[resolvedCliType] = sanitizedSelection;
    states.models = models;
  });
}

/**
 * Task Force 백엔드별 모델 설정을 초기화합니다 (origin으로 되돌림).
 */
export function resetTaskForceModelSelection(
  carrierId: string,
  cliType: string,
): void {
  const resolvedCliType = toTaskForceCliType(cliType);
  updateStates((states) => {
    const models = sanitizeSelectedModelsConfig(states.models);
    const carrierConfig = models[carrierId];
    if (!carrierConfig?.taskforce) return;

    delete carrierConfig.taskforce[resolvedCliType];
    pruneEmptyTaskForceConfig(carrierConfig);
    states.models = models;
  });
}

/**
 * 지정 캐리어에 대해 Task Force 실행 가능한 백엔드 목록을 반환합니다.
 */
export function getConfiguredTaskForceBackends(carrierId: string): TaskForceCliType[] {
  return getConfiguredTaskForceBackendsInConfig(loadModels(), carrierId);
}

export function getConfiguredTaskForceBackendsFromSnapshot(
  snapshot: FleetStoreSnapshot,
  carrierId: string,
): TaskForceCliType[] {
  return getConfiguredTaskForceBackendsInConfig(sanitizeSelectedModelsConfig(snapshot.models), carrierId);
}

/**
 * 등록된 전체 캐리어 중 Task Force 편성이 가능한 캐리어 ID 목록을 반환합니다.
 */
export function getConfiguredTaskForceCarrierIds(registeredIds: string[]): string[] {
  const config = loadModels();
  return registeredIds.filter((id) => isTaskForceFormableInConfig(config, id));
}

export function getConfiguredTaskForceCarrierIdsFromSnapshot(
  snapshot: FleetStoreSnapshot,
  registeredIds: string[],
): string[] {
  const config = sanitizeSelectedModelsConfig(snapshot.models);
  return registeredIds.filter((id) => isTaskForceFormableInConfig(config, id));
}

function sanitizeSelectedModelsConfig(raw: unknown): SelectedModelsConfig {
  if (!isRecord(raw)) return {};

  const result: SelectedModelsConfig = {};

  for (const [key, value] of Object.entries(raw)) {
    const sanitizedKey = sanitizeConfigKey(key);
    if (!sanitizedKey) continue;

    if (typeof value === "string") {
      const legacyModel = sanitizeFreeformText(value);
      if (!legacyModel) continue;
      result[sanitizedKey] = { model: legacyModel };
      continue;
    }

    const sanitizedSelection = sanitizeModelSelection(value);
    if (sanitizedSelection) {
      result[sanitizedKey] = sanitizedSelection;
    }
  }

  return result;
}

function sanitizeModelSelection(value: unknown): ModelSelection | null {
  if (!isRecord(value)) return null;
  const model = sanitizeFreeformText(value.model);
  if (!model) return null;

  const result: ModelSelection = { model };
  if (typeof value.direct === "boolean") result.direct = value.direct;

  const effort = sanitizeFreeformText(value.effort);
  if (effort) result.effort = effort;

  const taskforce = sanitizeTaskforceConfig(value.taskforce);
  if (taskforce) result.taskforce = taskforce;

  return result;
}

function sanitizeTaskforceConfig(value: unknown): TaskForceConfig | undefined {
  if (!isRecord(value)) return undefined;

  const taskforce: TaskForceConfig = {};
  for (const [cliKey, cliValue] of Object.entries(value)) {
    if (!isTaskForceCliType(cliKey)) continue;
    const sanitizedTaskforceSelection = sanitizeTaskForceSelection(cliKey, cliValue);
    if (sanitizedTaskforceSelection) {
      taskforce[cliKey] = sanitizedTaskforceSelection;
    }
  }

  return Object.keys(taskforce).length > 0 ? taskforce : undefined;
}

function getSanitizedTaskForceConfig(
  config: SelectedModelsConfig,
  carrierId: string,
): TaskForceConfig | undefined {
  return sanitizeTaskforceConfig(config[carrierId]?.taskforce);
}

function getConfiguredTaskForceBackendsInConfig(
  config: SelectedModelsConfig,
  carrierId: string,
): TaskForceCliType[] {
  const taskforceConfig = getSanitizedTaskForceConfig(config, carrierId);
  if (!taskforceConfig) return [];
  return TASKFORCE_CLI_TYPES.filter((cli) => taskforceConfig[cli as TaskForceCliType] != null) as TaskForceCliType[];
}

function isTaskForceFormableInConfig(
  config: SelectedModelsConfig,
  carrierId: string,
): boolean {
  return getConfiguredTaskForceBackendsInConfig(config, carrierId).length >= 2;
}

function sanitizeTaskForceSelection(cliType: CliType, value: unknown): TaskForceSelection | null {
  if (!isRecord(value)) return null;

  const provider = getProviderModels(cliType);
  const allowedModels = new Set(provider.models.map((model) => model.modelId));
  const model = sanitizeFreeformText(value.model);
  if (!model || !allowedModels.has(model)) return null;

  const result: TaskForceSelection = { model };
  const modelEffort = getEffort(cliType, model);
  const effort = sanitizeFreeformText(value.effort);

  if (modelEffort.supported) {
    result.effort = effort && modelEffort.levels.includes(effort)
      ? effort
      : modelEffort.default;
  }

  return result;
}

function ensureTaskForceConfig(
  config: SelectedModelsConfig,
  carrierId: string,
): TaskForceConfig {
  if (!config[carrierId]) {
    config[carrierId] = { model: "" };
  }

  if (!config[carrierId]!.taskforce) {
    config[carrierId]!.taskforce = {};
  }

  return config[carrierId]!.taskforce!;
}

function pruneEmptyTaskForceConfig(carrierConfig: ModelSelection): void {
  if (carrierConfig.taskforce && Object.keys(carrierConfig.taskforce).length === 0) {
    delete carrierConfig.taskforce;
  }
}

function toTaskForceCliType(value: string): TaskForceCliType {
  if (isTaskForceCliType(value)) {
    return value;
  }
  throw new Error(`Unsupported Task Force backend: ${value}`);
}

function isTaskForceCliType(value: string): value is TaskForceCliType {
  return TASKFORCE_CLI_TYPES.includes(value as CliType);
}

function sanitizeConfigKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || CONTROL_CHAR_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function sanitizeFreeformText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || CONTROL_CHAR_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
