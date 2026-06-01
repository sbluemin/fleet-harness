import {
  getEffort,
  getProviderModels,
  type CliType,
} from "@dotobokuri/fleet-unified-agent";
import { disconnect } from "@dotobokuri/fleet-infra/agent";
import {
  isRecord,
  sanitizeConfigKey,
  sanitizeFreeformText,
  sanitizeGeneration,
} from "./sanitize.js";
import { readStatesSnapshot, updateStates } from "./state-io.js";
import type {
  FleetStoreSnapshot,
  ModelSelection,
  PerCliSettings,
  SelectedModelsConfig,
  TaskForceConfig,
  TaskForceSelection,
} from "./types.js";

export interface CarrierModelDefaults {
  readonly cliType: CliType;
  readonly defaultEffort?: string;
  readonly defaultModel?: string;
}

export { applyCliTypeModelSelectionUpdate } from "./cli-types.js";

/** 현재 모델 설정을 로드합니다. */
export function loadModels(cliTypesByCarrier?: Record<string, CliType | CarrierModelDefaults>): SelectedModelsConfig {
  if (!cliTypesByCarrier) {
    return sanitizeSelectedModelsConfig(readStatesSnapshot().models);
  }

  const maxCasAttempts = 5;
  for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
    const expectedGeneration = readStatesSnapshot().generation;
    let abortedByConcurrentGeneration = false;

    updateStates((states) => {
      const diskGen = sanitizeGeneration(states._generation);
      if (diskGen !== expectedGeneration) {
        abortedByConcurrentGeneration = true;
        return;
      }

      const currentModels = sanitizeSelectedModelsConfig(states.models);
      const healedFull = buildHealedModels(currentModels, cliTypesByCarrier);
      let next: SelectedModelsConfig = currentModels;
      let changed = false;

      for (const carrierId of Object.keys(cliTypesByCarrier)) {
        const healed = healedFull[carrierId];
        if (!healed) continue;
        const cur = currentModels[carrierId];
        if (JSON.stringify(cur) !== JSON.stringify(healed)) {
          if (!changed) {
            next = { ...currentModels };
            changed = true;
          }
          next[carrierId] = healed;
        }
      }

      if (!changed) return;
      states.models = next;
    });

    if (!abortedByConcurrentGeneration) {
      return sanitizeSelectedModelsConfig(readStatesSnapshot().models);
    }
  }

  return sanitizeSelectedModelsConfig(readStatesSnapshot().models);
}

/**
 * Carrier의 모델 설정을 변경하고 live pool을 무효화합니다.
 */
export async function updateModelSelection(
  carrierId: string,
  selection: ModelSelection,
): Promise<void> {
  updateStates((states) => {
    const existing = states.models?.[carrierId];
    const merged: ModelSelection = {
      ...selection,
      taskforce: selection.taskforce ?? existing?.taskforce,
      perCliSettings: selection.perCliSettings ?? existing?.perCliSettings,
    };
    states.models = { ...states.models, [carrierId]: merged };
  });
  await disconnect(carrierId);
}

/**
 * CLI별 설정 캐시에서 특정 CLI 타입의 설정을 반환합니다.
 */
export function getPerCliSettings(
  carrierId: string,
  cliType: string,
  snapshot?: FleetStoreSnapshot,
): PerCliSettings | undefined {
  const config = snapshot?.models ? sanitizeSelectedModelsConfig(snapshot.models) : loadModels();
  const perCli = config[carrierId]?.perCliSettings;
  if (!perCli) return undefined;
  return sanitizePerCliSettings(perCli[cliType]);
}

/**
 * 현재 설정을 CLI별 설정 캐시에 저장합니다.
 * 원자적: read → merge → write (세션 무효화 없음)
 */
export function savePerCliSettings(
  carrierId: string,
  cliType: string,
  settings: PerCliSettings,
): void {
  if (
    settings.model === undefined &&
    settings.effort === undefined &&
    settings.direct === undefined
  ) {
    return;
  }

  const sanitizedKey = sanitizeConfigKey(cliType);
  if (!sanitizedKey) return;

  updateStates((states) => {
    if (!states.models) states.models = {};
    if (!states.models[carrierId]) states.models[carrierId] = { model: "" };

    const carrier = states.models[carrierId]!;
    if (!carrier.perCliSettings) carrier.perCliSettings = {};
    carrier.perCliSettings[sanitizedKey] = {
      model: settings.model,
      effort: settings.effort,
      direct: settings.direct,
    };
  });
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

  const taskforce = sanitizeTaskforceConfig(value.taskforce);
  const perCliSettings = sanitizeAllPerCliSettings(value.perCliSettings);
  const model = sanitizeFreeformText(value.model);
  if (!model && !taskforce && !perCliSettings) return null;

  const result: ModelSelection = { model: model ?? "" };

  if (typeof value.direct === "boolean") {
    result.direct = value.direct;
  }

  const effort = sanitizeFreeformText(value.effort);
  if (effort) {
    result.effort = effort;
  }

  if (taskforce) {
    result.taskforce = taskforce;
  }

  if (perCliSettings) {
    result.perCliSettings = perCliSettings;
  }

  return result;
}

function sanitizePerCliSettings(value: unknown): PerCliSettings | undefined {
  if (!isRecord(value)) return undefined;
  const result: PerCliSettings = {};
  let hasField = false;

  const model = sanitizeFreeformText(value.model);
  if (model) { result.model = model; hasField = true; }

  const effort = sanitizeFreeformText(value.effort);
  if (effort) { result.effort = effort; hasField = true; }

  if (typeof value.direct === "boolean") { result.direct = value.direct; hasField = true; }

  return hasField ? result : undefined;
}

function sanitizeAllPerCliSettings(
  value: unknown,
): Partial<Record<string, PerCliSettings>> | undefined {
  if (!isRecord(value)) return undefined;

  const result: Partial<Record<string, PerCliSettings>> = {};
  let hasEntry = false;

  for (const [key, entry] of Object.entries(value)) {
    const sanitizedKey = sanitizeConfigKey(key);
    if (!sanitizedKey) continue;
    const sanitized = sanitizePerCliSettings(entry);
    if (sanitized) {
      result[sanitizedKey] = sanitized;
      hasEntry = true;
    }
  }

  return hasEntry ? result : undefined;
}

function sanitizeTaskforceConfig(value: unknown): TaskForceConfig | undefined {
  if (!isRecord(value)) return undefined;

  const taskforce: TaskForceConfig = {};
  for (const [cliKey, cliValue] of Object.entries(value)) {
    const sanitizedKey = sanitizeConfigKey(cliKey);
    const sanitizedTaskforceSelection = sanitizeTaskForceSelection(cliValue);
    if (sanitizedKey && sanitizedTaskforceSelection) {
      (taskforce as Partial<Record<string, TaskForceSelection>>)[sanitizedKey] = sanitizedTaskforceSelection;
    }
  }

  return Object.keys(taskforce).length > 0 ? taskforce : undefined;
}

function resolveSelectionForCliType(
  current: ModelSelection,
  cliType: CliType,
  defaults?: CarrierModelDefaults,
): ModelSelection | null {
  const provider = getProviderModels(cliType);
  const allowedModels = new Set(provider.models.map((model) => model.modelId));
  const saved = sanitizePerCliSettings(current.perCliSettings?.[cliType]);
  const defaultModelIsValid = !!defaults?.defaultModel && allowedModels.has(defaults.defaultModel);

  const currentModelIsValid = allowedModels.has(current.model);
  const savedModelIsValid = !!saved?.model && allowedModels.has(saved.model);
  const model = currentModelIsValid
    ? current.model
    : savedModelIsValid
      ? saved.model!
      : defaultModelIsValid
        ? defaults.defaultModel!
        : provider.defaultModel;

  const result: ModelSelection = { model };
  const modelEffort = getEffort(cliType, model);

  if (modelEffort.supported) {
    const effort = currentModelIsValid && current.effort && modelEffort.levels.includes(current.effort)
      ? current.effort
      : !currentModelIsValid && savedModelIsValid && saved?.effort && modelEffort.levels.includes(saved.effort)
        ? saved.effort
        : defaults?.defaultEffort && modelEffort.levels.includes(defaults.defaultEffort)
          ? defaults.defaultEffort
          : modelEffort.default;

    result.effort = effort;
  }

  if (current.direct !== undefined) {
    result.direct = current.direct;
  } else if (saved?.direct !== undefined) {
    result.direct = saved.direct;
  }

  return result;
}

function buildHealedModels(
  config: SelectedModelsConfig,
  cliTypesByCarrier: Record<string, CliType | CarrierModelDefaults>,
): SelectedModelsConfig {
  const next = structuredClone(config);
  for (const [carrierId, cliTypeOrDefaults] of Object.entries(cliTypesByCarrier)) {
    const cliType = typeof cliTypeOrDefaults === "string" ? cliTypeOrDefaults : cliTypeOrDefaults.cliType;
    const defaults = typeof cliTypeOrDefaults === "string" ? undefined : cliTypeOrDefaults;
    const provider = getProviderModels(cliType);
    const current = next[carrierId];
    if (!current) {
      const defaultModel = defaults?.defaultModel && provider.models.some((model) => model.modelId === defaults.defaultModel)
        ? defaults.defaultModel
        : provider.defaultModel;
      const effort = getEffort(cliType, defaultModel);
      next[carrierId] = {
        model: defaultModel,
        ...(effort.supported && defaults?.defaultEffort && effort.levels.includes(defaults.defaultEffort)
          ? { effort: defaults.defaultEffort }
          : {}),
      };
      continue;
    }
    const resolved = resolveSelectionForCliType(current, cliType, defaults);
    if (!resolved) continue;
    next[carrierId] = {
      model: resolved.model,
      ...(resolved.effort ? { effort: resolved.effort } : {}),
      ...(resolved.direct !== undefined ? { direct: resolved.direct } : {}),
      ...(current.taskforce ? { taskforce: current.taskforce } : {}),
      ...(current.perCliSettings ? { perCliSettings: current.perCliSettings } : {}),
    };
  }
  return next;
}

function sanitizeTaskForceSelection(value: unknown): TaskForceSelection | null {
  if (!isRecord(value)) return null;
  const model = sanitizeFreeformText(value.model);
  if (!model) return null;

  const result: TaskForceSelection = { model };
  const effort = sanitizeFreeformText(value.effort);
  if (effort) result.effort = effort;
  if (typeof value.direct === "boolean") result.direct = value.direct;
  return result;
}
