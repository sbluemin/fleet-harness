import { CLI_BACKENDS, type CliType } from "@sbluemin/fleet-unified-agent";
import { disconnect, flushSessionMappings, getCarrierSessionStore } from "@sbluemin/fleet-infra/agent";
import { readStatesSnapshot, updateStates } from "./state-io.js";
import type {
  ModelSelection,
  PerCliSettings,
  SelectedModelsConfig,
  TaskForceConfig,
  TaskForceSelection,
} from "./types.js";

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/** 유효한 cliType 값 집합 */
const VALID_CLI_TYPES = new Set(Object.keys(CLI_BACKENDS));

/**
 * 디스크에서 cliType 오버라이드 맵을 로드합니다.
 * 유효한 carrier ID와 cliType 값만 필터링하여 반환합니다.
 */
export function loadCliTypeOverrides(validIds?: Set<string>): Record<string, string> {
  const overrides = readStatesSnapshot().cliTypeOverrides;
  if (!validIds) return overrides;
  return Object.fromEntries(
    Object.entries(overrides).filter(([id]) => validIds.has(id)),
  );
}

/** 디스크의 carrier별 cliType override를 읽어 현재 등록에 사용할 CLI를 결정합니다. */
export function resolveCarrierCliType(carrierId: string, defaultCliType: CliType): CliType {
  const overrides = readStatesSnapshot().cliTypeOverrides;
  return (overrides[carrierId] as CliType | undefined) ?? defaultCliType;
}

/**
 * 단일 carrier의 cliType 오버라이드를 저장하거나 기본값이면 제거합니다.
 */
export function updateCliTypeOverride(
  carrierId: string,
  cliType: string,
  defaultCliType: string,
): void {
  const sanitizedCarrierId = sanitizeConfigKey(carrierId);
  if (!sanitizedCarrierId) return;
  if (!VALID_CLI_TYPES.has(cliType) || !VALID_CLI_TYPES.has(defaultCliType)) return;

  updateStates((states) => {
    const overrides = sanitizeCliTypeOverrides(states.cliTypeOverrides);
    if (cliType === defaultCliType) {
      delete overrides[sanitizedCarrierId];
    } else {
      overrides[sanitizedCarrierId] = cliType;
    }
    if (Object.keys(overrides).length > 0) {
      states.cliTypeOverrides = overrides;
    } else {
      delete states.cliTypeOverrides;
    }
  });
}

export async function applyCliTypeModelSelectionUpdate(
  carrierId: string,
  nextCliType: CliType,
  defaultCliType: CliType,
  previousCliType: CliType | null,
  previousSelection: PerCliSettings | undefined,
  selection: ModelSelection,
): Promise<void> {
  updateStates((states) => {
    const models = sanitizeSelectedModelsConfig(states.models);
    const current = models[carrierId];
    const perCliSettings = { ...(current?.perCliSettings ?? {}) };
    if (previousCliType && previousSelection) {
      perCliSettings[previousCliType] = previousSelection;
    }
    models[carrierId] = {
      ...selection,
      taskforce: current?.taskforce,
      perCliSettings,
    };
    states.models = models;

    const overrides = sanitizeCliTypeOverrides(states.cliTypeOverrides);
    if (nextCliType === defaultCliType) {
      delete overrides[carrierId];
    } else {
      overrides[carrierId] = nextCliType;
    }
    if (Object.keys(overrides).length > 0) {
      states.cliTypeOverrides = overrides;
    } else {
      delete states.cliTypeOverrides;
    }
  });
  getCarrierSessionStore().clear(carrierId);
  flushSessionMappings();
  await disconnect(carrierId);
}

function sanitizeCliTypeOverrides(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [id, cliType] of Object.entries(value)) {
    const sanitizedId = sanitizeConfigKey(id);
    if (!sanitizedId || typeof cliType !== "string" || !VALID_CLI_TYPES.has(cliType)) continue;
    result[sanitizedId] = cliType;
  }
  return result;
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
