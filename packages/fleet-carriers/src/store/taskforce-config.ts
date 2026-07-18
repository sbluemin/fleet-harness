import {
  getEffort,
  getProviderModels,
  type CliType,
} from "@dotobokuri/core-unified-agent";

import { TASKFORCE_CLI_TYPES, type TaskForceCliType } from "../dispatch/types.js";
import {
  sanitizeConfigKey,
  sanitizeFreeformText,
  sanitizeTaskforce,
} from "./sanitize.js";
import { readRawCarriers, updateCarriers } from "./state-io.js";
import type {
  FleetStoreSnapshot,
  TaskForceConfig,
  TaskForceSelection,
} from "./types.js";

export function getTaskForceModelConfig(
  carrierId: string,
  cliType: string,
  snapshot?: FleetStoreSnapshot,
): TaskForceSelection | undefined {
  const resolvedCliType = toTaskForceCliType(cliType);
  const taskforce = snapshot?.carriers[carrierId]?.taskforce
    ?? sanitizeTaskforce(readRawCarriers().carriers?.[carrierId]?.taskforce);
  return taskforce[resolvedCliType];
}

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

  updateCarriers((states) => {
    const carriers = { ...(states.carriers ?? {}) };
    const current = carriers[carrierId] ?? {};
    carriers[carrierId] = {
      ...current,
      taskforce: {
        ...sanitizeTaskforce(current.taskforce),
        [resolvedCliType]: sanitizedSelection,
      },
    };
    states.carriers = carriers;
  });
}

export function resetTaskForceModelSelection(
  carrierId: string,
  cliType: string,
): void {
  const resolvedCliType = toTaskForceCliType(cliType);
  updateCarriers((states) => {
    const carriers = { ...(states.carriers ?? {}) };
    const current = carriers[carrierId];
    if (!current?.taskforce) return;
    const taskforce = sanitizeTaskforce(current.taskforce);
    delete taskforce[resolvedCliType];
    carriers[carrierId] = {
      ...current,
      ...(Object.keys(taskforce).length > 0 ? { taskforce } : {}),
    };
    if (Object.keys(taskforce).length === 0) delete carriers[carrierId].taskforce;
    states.carriers = carriers;
  });
}

export function resetCarrierTaskForceConfig(carrierId: string): boolean {
  const sanitizedCarrierId = sanitizeConfigKey(carrierId);
  if (!sanitizedCarrierId) return false;
  let removed = false;

  updateCarriers((states) => {
    const carriers = { ...(states.carriers ?? {}) };
    const current = carriers[sanitizedCarrierId];
    if (!current?.taskforce) return;
    carriers[sanitizedCarrierId] = { ...current };
    delete carriers[sanitizedCarrierId].taskforce;
    states.carriers = carriers;
    removed = true;
  });

  return removed;
}

export function getConfiguredTaskForceBackends(carrierId: string): TaskForceCliType[] {
  return getConfiguredTaskForceBackendsInConfig(
    sanitizeTaskforce(readRawCarriers().carriers?.[carrierId]?.taskforce),
  );
}

export function getConfiguredTaskForceBackendsFromSnapshot(
  snapshot: FleetStoreSnapshot,
  carrierId: string,
): TaskForceCliType[] {
  return getConfiguredTaskForceBackendsInConfig(snapshot.carriers[carrierId]?.taskforce ?? {});
}

function getConfiguredTaskForceBackendsInConfig(taskforceConfig: TaskForceConfig): TaskForceCliType[] {
  return TASKFORCE_CLI_TYPES.filter((cli) => taskforceConfig[cli as TaskForceCliType] != null) as TaskForceCliType[];
}

function sanitizeTaskForceSelection(cliType: CliType, value: unknown): TaskForceSelection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const provider = getProviderModels(cliType);
  const allowedModels = new Set(provider.models.map((model) => model.modelId));
  const model = sanitizeFreeformText((value as { model?: unknown }).model);
  if (!model || !allowedModels.has(model)) return null;

  const result: TaskForceSelection = { model };
  const modelEffort = getEffort(cliType, model);
  const effort = sanitizeFreeformText((value as { effort?: unknown }).effort);

  if (modelEffort.supported) {
    result.effort = effort && modelEffort.levels.includes(effort)
      ? effort
      : modelEffort.default;
  }

  return result;
}

function toTaskForceCliType(value: string): TaskForceCliType {
  const sanitized = sanitizeConfigKey(value);
  if (sanitized && isTaskForceCliType(sanitized)) return sanitized;
  throw new Error(`Unsupported Task Force backend: ${value}`);
}

function isTaskForceCliType(value: string): value is TaskForceCliType {
  return TASKFORCE_CLI_TYPES.includes(value as CliType);
}
