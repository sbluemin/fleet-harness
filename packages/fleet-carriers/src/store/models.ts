import {
  getEffort,
  getProviderModels,
  type CliType,
} from "@dotobokuri/fleet-unified-agent";
import { disconnect } from "@dotobokuri/fleet-infra/agent";

import {
  sanitizeAgentCli,
  sanitizeAgentCliSelectionForCliType,
  sanitizeConfigKey,
} from "./sanitize.js";
import { readRawCarriers, updateCarriers } from "./state-io.js";
import type {
  AgentCliConfig,
  AgentCliSelection,
  CarrierAgentMode,
  CarrierState,
  FleetStoreSnapshot,
  ResolvedCarrierState,
} from "./types.js";

export interface CarrierModelDefaults {
  readonly cliType: CliType;
  readonly defaultAgentMode?: CarrierAgentMode;
  readonly defaultEffort?: string;
  readonly defaultModel?: string;
}

export { applyAgentCliTypeSelectionUpdate } from "./cli-types.js";

export function loadCarrierStates(defaultsByCarrier?: Record<string, CliType | CarrierModelDefaults>): Record<string, ResolvedCarrierState> {
  return buildHealedCarriers(defaultsByCarrier);
}

export async function updateAgentCliSelection(
  carrierId: string,
  cliType: CliType,
  selection: AgentCliSelection,
): Promise<void> {
  const sanitizedCarrierId = sanitizeConfigKey(carrierId);
  const sanitizedSelection = sanitizeAgentCliSelectionForCliType(cliType, selection);
  if (!sanitizedCarrierId || !sanitizedSelection) return;

  updateCarriers((states) => {
    const carriers = { ...(states.carriers ?? {}) };
    const current = carriers[sanitizedCarrierId] ?? {};
    carriers[sanitizedCarrierId] = {
      ...current,
      agentCli: {
        ...sanitizeAgentCli(current.agentCli),
        [cliType]: sanitizedSelection,
      },
    };
    states.carriers = carriers;
  });
  await disconnect(sanitizedCarrierId);
}

export function getAgentCliSelection(
  carrierId: string,
  cliType: CliType,
  snapshot?: FleetStoreSnapshot,
): AgentCliSelection | undefined {
  const selection = snapshot?.carriers[carrierId]?.agentCli[cliType]
    ?? sanitizeAgentCli(readRawCarriers().carriers?.[carrierId]?.agentCli)[cliType];
  return sanitizeAgentCliSelectionForCliType(cliType, selection);
}

export function saveAgentCliSelection(
  carrierId: string,
  cliType: CliType,
  selection: AgentCliSelection,
): void {
  const sanitizedCarrierId = sanitizeConfigKey(carrierId);
  const sanitizedSelection = sanitizeAgentCliSelectionForCliType(cliType, selection);
  if (!sanitizedCarrierId || !sanitizedSelection) return;

  updateCarriers((states) => {
    const carriers = { ...(states.carriers ?? {}) };
    const current = carriers[sanitizedCarrierId] ?? {};
    carriers[sanitizedCarrierId] = {
      ...current,
      agentCli: {
        ...sanitizeAgentCli(current.agentCli),
        [cliType]: sanitizedSelection,
      },
    };
    states.carriers = carriers;
  });
}

export function buildHealedCarriers(
  defaultsByCarrier: Record<string, CliType | CarrierModelDefaults> = {},
): Record<string, ResolvedCarrierState> {
  const raw = readRawCarriers();
  const carrierIds = new Set([
    ...Object.keys(raw.carriers ?? {}),
    ...Object.keys(defaultsByCarrier),
  ]);
  const result: Record<string, ResolvedCarrierState> = {};
  for (const carrierId of carrierIds) {
    const state = raw.carriers?.[carrierId] ?? {};
    const defaults = normalizeDefaults(defaultsByCarrier[carrierId]);
    result[carrierId] = resolveCarrierState(state, defaults);
  }
  return result;
}

export function resolveCarrierState(
  state: CarrierState,
  defaults?: CarrierModelDefaults,
): ResolvedCarrierState {
  const agentCliType = state.agentCliType ?? defaults?.cliType ?? "claude";
  const agentCli = sanitizeAgentCli(state.agentCli);
  const activeSelection = resolveSelectionForCliType(agentCli[agentCliType], agentCliType, defaults);
  return {
    agentMode: state.agentMode ?? defaults?.defaultAgentMode ?? "cli",
    agentCliType,
    agentCli: {
      ...agentCli,
      [agentCliType]: activeSelection,
    },
    taskforce: state.taskforce ?? {},
    ...(state.displayName ? { displayName: state.displayName } : {}),
  };
}

function normalizeDefaults(value: CliType | CarrierModelDefaults | undefined): CarrierModelDefaults | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? { cliType: value } : value;
}

function resolveSelectionForCliType(
  stored: AgentCliSelection | undefined,
  cliType: CliType,
  defaults?: CarrierModelDefaults,
): AgentCliSelection {
  const provider = getProviderModels(cliType);
  const allowedModels = new Set(provider.models.map((model) => model.modelId));
  const defaultModelIsValid = !!defaults?.defaultModel && allowedModels.has(defaults.defaultModel);
  const storedModelIsValid = !!stored?.model && allowedModels.has(stored.model);
  const model = storedModelIsValid
    ? stored!.model
    : defaultModelIsValid
      ? defaults!.defaultModel!
      : provider.defaultModel;
  const modelEffort = getEffort(cliType, model);
  if (!modelEffort.supported) return { model };
  const effort = storedModelIsValid && stored?.effort && modelEffort.levels.includes(stored.effort)
    ? stored.effort
    : defaults?.defaultEffort && modelEffort.levels.includes(defaults.defaultEffort)
      ? defaults.defaultEffort
      : modelEffort.default;
  return { model, effort };
}
