import {
  getEffort,
  getProviderModels,
  type CliType,
} from "@dotobokuri/core-unified-agent";
import {
  sanitizeAgentCli,
  sanitizeAgentCliSelectionForCliType,
  sanitizeAgentCliType,
  sanitizeConfigKey,
  sanitizeGeneration,
  sanitizeTaskforce,
} from "./sanitize.js";
import { readRawCarriers, readRawCarriersOrDefaultStore, updateCarriers } from "./state-io.js";
import type {
  AgentCliSelection,
  CarrierModelDefaults,
  CarrierState,
  FleetCarriers,
  FleetStoreSnapshot,
  ResolvedCarrierState,
  TaskForceConfig,
} from "./types.js";

export function loadCarrierStates(defaultsByCarrier?: Record<string, CliType | CarrierModelDefaults>): Record<string, ResolvedCarrierState> {
  return buildHealedCarriers(defaultsByCarrier);
}

/** raw carriers.json을 읽어 generation과 sanitize-힐링된 carrier 상태 스냅샷을 반환합니다. */
export function readCarriersSnapshot(
  defaultsByCarrier: Record<string, CliType | CarrierModelDefaults> = {},
): FleetStoreSnapshot {
  return buildCarriersSnapshot(readRawCarriers(), defaultsByCarrier);
}

export function readFileBackedCarriersSnapshot(
  defaultsByCarrier: Record<string, CliType | CarrierModelDefaults> = {},
): FleetStoreSnapshot {
  return buildCarriersSnapshot(readRawCarriersOrDefaultStore(), defaultsByCarrier);
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
  return resolveCarriersRecord(readRawCarriers(), defaultsByCarrier, resolveCarrierState);
}

export function resolveCarrierState(
  state: CarrierState,
  defaults?: CarrierModelDefaults,
): ResolvedCarrierState {
  return buildResolvedCarrierState(
    state,
    defaults,
    state.agentCliType ?? defaults?.cliType ?? "claude",
    state.taskforce ?? {},
  );
}

/** snapshot 경로 전용 — agentCliType/taskforce를 sanitize 경유로 해석합니다. */
function resolveSnapshotCarrierState(
  state: CarrierState,
  defaults?: CarrierModelDefaults,
): ResolvedCarrierState {
  return buildResolvedCarrierState(
    state,
    defaults,
    sanitizeAgentCliType(state.agentCliType) ?? defaults?.cliType ?? "claude",
    sanitizeTaskforce(state.taskforce),
  );
}

function buildCarriersSnapshot(
  raw: FleetCarriers,
  defaultsByCarrier: Record<string, CliType | CarrierModelDefaults>,
): FleetStoreSnapshot {
  return {
    generation: sanitizeGeneration(raw._meta?.generation),
    carriers: resolveCarriersRecord(raw, defaultsByCarrier, resolveSnapshotCarrierState),
  };
}

/** carrierIds 합집합(raw 키 + defaults 키)을 순회하며 상태를 해석하는 공통 흐름 */
function resolveCarriersRecord(
  raw: FleetCarriers,
  defaultsByCarrier: Record<string, CliType | CarrierModelDefaults>,
  resolve: (state: CarrierState, defaults?: CarrierModelDefaults) => ResolvedCarrierState,
): Record<string, ResolvedCarrierState> {
  const carrierIds = new Set([
    ...Object.keys(raw.carriers ?? {}),
    ...Object.keys(defaultsByCarrier),
  ]);
  const result: Record<string, ResolvedCarrierState> = {};
  for (const carrierId of carrierIds) {
    const state = raw.carriers?.[carrierId] ?? {};
    const defaults = normalizeDefaults(defaultsByCarrier[carrierId]);
    result[carrierId] = resolve(state, defaults);
  }
  return result;
}

function buildResolvedCarrierState(
  state: CarrierState,
  defaults: CarrierModelDefaults | undefined,
  agentCliType: CliType,
  taskforce: TaskForceConfig,
): ResolvedCarrierState {
  const agentCli = sanitizeAgentCli(state.agentCli);
  return {
    agentCliType,
    agentCli: {
      ...agentCli,
      [agentCliType]: resolveSelectionForCliType(agentCli[agentCliType], agentCliType, defaults),
    },
    taskforce,
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
