import {
  getEffort,
  getProviderModels,
  type CliType,
} from "@dotobokuri/fleet-unified-agent";
import { disconnect, sessionRuntime } from "@dotobokuri/fleet-infra/agent";
import { readStatesSnapshot, updateStates } from "./state-io.js";
import type {
  FleetStoreSnapshot,
  ModelSelection,
  PerCliSettings,
  SelectedModelsConfig,
  TaskForceConfig,
  TaskForceSelection,
} from "./types.js";

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

export { applyCliTypeModelSelectionUpdate } from "./cli-types.js";

/** 현재 모델 설정을 로드합니다. */
export function loadModels(cliTypesByCarrier?: Record<string, CliType>): SelectedModelsConfig {
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

/** 모델 설정을 저장합니다. */
export function saveModels(config: SelectedModelsConfig): void {
  updateStates((states) => {
    states.models = sanitizeSelectedModelsConfig(config);
  });
}

/**
 * states.json에 모델 엔트리가 없는 캐리어에 대해 defaultModel로 초기 시딩합니다.
 * 세션 무효화는 수행하지 않습니다 (부팅 시 1회만 실행).
 *
 * @returns 실제로 states.json이 갱신되었는지 여부
 */
export function seedDefaultModels(
  defaultsByCarrier: Record<string, { cliType: CliType; defaultModel?: string; defaultEffort?: string }>,
): boolean {
  const entries = Object.entries(defaultsByCarrier);
  if (entries.length === 0) return false;

  let changed = false;
  updateStates((states) => {
    const models = sanitizeSelectedModelsConfig(states.models);

    for (const [carrierId, { cliType, defaultModel, defaultEffort }] of entries) {
      const existing = models[carrierId];
      if (existing && existing.model) continue;
      const model = defaultModel ?? getProviderModels(cliType)?.defaultModel;
      if (!model) continue;
      const next: ModelSelection = { ...existing, model };
      if (defaultEffort && !existing?.effort) next.effort = defaultEffort;
      models[carrierId] = next;
      changed = true;
    }

    if (changed) states.models = models;
  });
  return changed;
}

/**
 * Carrier의 모델 설정을 변경하고 세션을 무효화합니다.
 * 원자적 연산: save → session clear → disconnect
 * clear 먼저: executor가 stale sessionId로 resume 시도하는 창 제거
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
  sessionRuntime.getCarrierSessionStore().clear(carrierId);
  sessionRuntime.flushSessionMappings();
  await disconnect(carrierId);
}

/**
 * 전체 모델 설정을 교체하고 변경된 키의 세션을 무효화합니다.
 * 원자적 연산: save → session clear all → disconnect all
 */
export async function updateAllModelSelections(
  config: SelectedModelsConfig,
): Promise<void> {
  saveModels(config);
  const keys = Object.keys(config);
  const sessionStore = sessionRuntime.getCarrierSessionStore();
  for (const key of keys) {
    sessionStore.clear(key);
  }
  sessionRuntime.flushSessionMappings();
  await Promise.allSettled(keys.map((key) => disconnect(key)));
}

/**
 * 현재 carrier별 cliType에 맞춰 활성 모델 선택을 재정렬합니다.
 *
 * /reload 후 carrier의 cliType이 복원되어도 top-level models 엔트리가
 * 이전 CLI 기준 값으로 남아 있을 수 있으므로, 현재 cliType 기준 유효한
 * model/effort/budget/direct 조합으로 정규화합니다.
 *
 * - 현재 top-level 선택이 새 cliType에 유효하면 그대로 유지
 * - 아니면 perCliSettings[cliType]를 사용
 * - 그것도 없으면 provider 기본값으로 폴백
 *
 * taskforce/perCliSettings는 보존하며 세션 무효화는 수행하지 않습니다.
 *
 * @returns 실제로 states.json이 갱신되었는지 여부
 */
export function reconcileActiveModelSelections(
  cliTypesByCarrier: Record<string, CliType>,
): boolean {
  if (Object.keys(cliTypesByCarrier).length === 0) return false;

  let changed = false;
  updateStates((states) => {
    const models = sanitizeSelectedModelsConfig(states.models);

    for (const [carrierId, cliType] of Object.entries(cliTypesByCarrier)) {
      const current = models[carrierId];
      if (!current) continue;

      const resolved = resolveSelectionForCliType(current, cliType);
      if (!resolved) continue;

      if (!isSameResolvedSelection(current, resolved)) {
        const next: ModelSelection = { model: resolved.model };
        if (resolved.direct !== undefined) next.direct = resolved.direct;
        if (resolved.effort !== undefined) next.effort = resolved.effort;
        if (current.taskforce) next.taskforce = current.taskforce;
        if (current.perCliSettings) next.perCliSettings = current.perCliSettings;
        models[carrierId] = next;
        changed = true;
      }
    }

    if (changed) states.models = models;
  });
  return changed;
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
): ModelSelection | null {
  const provider = getProviderModels(cliType);
  const allowedModels = new Set(provider.models.map((model) => model.modelId));
  const saved = sanitizePerCliSettings(current.perCliSettings?.[cliType]);

  const currentModelIsValid = allowedModels.has(current.model);
  const savedModelIsValid = !!saved?.model && allowedModels.has(saved.model);
  const model = currentModelIsValid
    ? current.model
    : savedModelIsValid
      ? saved.model!
      : provider.defaultModel;

  const result: ModelSelection = { model };
  const modelEffort = getEffort(cliType, model);

  if (modelEffort.supported) {
    const effort = currentModelIsValid && current.effort && modelEffort.levels.includes(current.effort)
      ? current.effort
      : !currentModelIsValid && savedModelIsValid && saved?.effort && modelEffort.levels.includes(saved.effort)
        ? saved.effort
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
  cliTypesByCarrier: Record<string, CliType>,
): SelectedModelsConfig {
  const next = structuredClone(config);
  for (const [carrierId, cliType] of Object.entries(cliTypesByCarrier)) {
    const provider = getProviderModels(cliType);
    const current = next[carrierId];
    if (!current) {
      next[carrierId] = { model: provider.defaultModel };
      continue;
    }
    const resolved = resolveSelectionForCliType(current, cliType);
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

function isSameResolvedSelection(
  current: ModelSelection,
  resolved: ModelSelection,
): boolean {
  return current.model === resolved.model
    && current.effort === resolved.effort
    && current.direct === resolved.direct;
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

function sanitizeGeneration(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) return 0;
  return value as number;
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
