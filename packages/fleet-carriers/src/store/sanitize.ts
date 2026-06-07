import {
  CLI_BACKENDS,
  getEffort,
  getProviderModels,
  type CliType,
} from "@dotobokuri/core-unified-agent";

import type {
  AgentCliConfig,
  AgentCliSelection,
  CarrierAgentMode,
  CarrierState,
  TaskForceConfig,
  TaskForceSelection,
} from "./types.js";

export const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
export const CONTROL_AND_C1_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const INVISIBLE_CHAR_PATTERN = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function sanitizeGeneration(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) return 0;
  return value as number;
}

export function sanitizeConfigKey(
  value: string,
  controlPattern: RegExp = CONTROL_CHAR_PATTERN,
): string | null {
  const trimmed = value.trim();
  if (!trimmed || controlPattern.test(trimmed) || PROTOTYPE_KEYS.has(trimmed)) return null;
  return trimmed;
}

export function sanitizeFreeformText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(INVISIBLE_CHAR_PATTERN, "").trim();
  if (!trimmed || CONTROL_AND_C1_CHAR_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeAgentMode(value: unknown): CarrierAgentMode | undefined {
  return value === "cli" || value === "subagent" ? value : undefined;
}

export function sanitizeAgentCliType(value: unknown): CliType | undefined {
  return typeof value === "string" && value in CLI_BACKENDS ? value as CliType : undefined;
}

export function sanitizeAgentCliSelection(value: unknown): AgentCliSelection | undefined {
  if (!isRecord(value)) return undefined;
  const model = sanitizeFreeformText(value.model);
  if (!model) return undefined;
  const effort = sanitizeFreeformText(value.effort);
  return {
    model,
    ...(effort ? { effort } : {}),
  };
}

export function sanitizeAgentCliSelectionForCliType(
  cliType: CliType,
  value: unknown,
): AgentCliSelection | undefined {
  const selection = sanitizeAgentCliSelection(value);
  if (!selection) return undefined;
  const provider = getProviderModels(cliType);
  if (!provider.models.some((model) => model.modelId === selection.model)) return undefined;
  const effort = getEffort(cliType, selection.model);
  if (!effort.supported) return { model: selection.model };
  return {
    model: selection.model,
    ...(selection.effort && effort.levels.includes(selection.effort) ? { effort: selection.effort } : {}),
  };
}

export function sanitizeAgentCli(value: unknown): AgentCliConfig {
  if (!isRecord(value)) return {};
  const result = Object.create(null) as AgentCliConfig;
  for (const [cliType, selection] of Object.entries(value)) {
    const sanitizedCliType = sanitizeAgentCliType(cliType);
    const sanitizedSelection = sanitizedCliType
      ? sanitizeAgentCliSelectionForCliType(sanitizedCliType, selection)
      : undefined;
    if (sanitizedCliType && sanitizedSelection) result[sanitizedCliType] = sanitizedSelection;
  }
  return result;
}

export function sanitizeTaskforce(value: unknown): TaskForceConfig {
  if (!isRecord(value)) return {};
  const result = Object.create(null) as TaskForceConfig;
  for (const [cliType, selection] of Object.entries(value)) {
    const sanitizedCliType = sanitizeAgentCliType(cliType);
    const sanitizedSelection = sanitizeAgentCliSelection(selection) as TaskForceSelection | undefined;
    if (sanitizedCliType && sanitizedSelection) {
      (result as Partial<Record<string, TaskForceSelection>>)[sanitizedCliType] = sanitizedSelection;
    }
  }
  return result;
}

export function sanitizeCarrierState(value: unknown): CarrierState | undefined {
  if (!isRecord(value)) return undefined;
  const agentMode = sanitizeAgentMode(value.agentMode);
  const agentCliType = sanitizeAgentCliType(value.agentCliType);
  const agentCli = sanitizeAgentCli(value.agentCli);
  const taskforce = sanitizeTaskforce(value.taskforce);
  const displayName = sanitizeFreeformText(value.displayName);
  const result: CarrierState = {};
  if (agentMode) result.agentMode = agentMode;
  if (agentCliType) result.agentCliType = agentCliType;
  if (Object.keys(agentCli).length > 0) result.agentCli = agentCli;
  if (Object.keys(taskforce).length > 0) result.taskforce = taskforce;
  if (displayName) result.displayName = displayName;
  return Object.keys(result).length > 0 ? result : {};
}

export function sanitizeCarriersMap(value: unknown): Record<string, CarrierState> {
  if (!isRecord(value)) return {};
  const result = Object.create(null) as Record<string, CarrierState>;
  for (const [carrierId, state] of Object.entries(value)) {
    const sanitizedCarrierId = sanitizeConfigKey(carrierId);
    const sanitizedState = sanitizeCarrierState(state);
    if (sanitizedCarrierId && sanitizedState && Object.keys(sanitizedState).length > 0) {
      result[sanitizedCarrierId] = sanitizedState;
    }
  }
  return result;
}
