import {
  CLI_DISPLAY_NAMES,
  getCarrierConfig,
  getConfiguredTaskForceBackendsFromSnapshot,
  getRegisteredOrder,
  loadModels,
  readStatesSnapshot,
  readCarrierSubagentModeSnapshot,
  resolveCarrierDisplayName,
  type CarrierModelDefaults,
  type CarrierRuntime,
} from "@dotobokuri/fleet-carriers";
import { sanitizeToolBlockLabel } from "@dotobokuri/fleet-carriers";
import { getCliEffortLevels, getCliModels } from "@dotobokuri/fleet-infra/agent";

import type { GroupedEntries, StatusOverlayViewModel } from "./render-types.js";
import type { CarrierCliType, CarrierStatusEntry, CliModelInfo, FleetStoreSnapshot } from "./types.js";

const ANSI_DIM = "\x1b[38;2;100;100;100m";
const CATEGORY_ORDER = ["strategy", "planning", "operations"] as const;
const CATEGORY_LABELS: Record<string, string> = {
  operations: "Operations",
  planning: "Planning",
  strategy: "Strategy",
  uncategorized: "Uncategorized",
};
const CATEGORY_COLORS: Record<string, string> = {
  operations: "\x1b[38;2;80;200;120m",
  planning: "\x1b[38;2;180;140;255m",
  strategy: "\x1b[38;2;100;180;255m",
  uncategorized: ANSI_DIM,
};
const ROLE_DESCRIPTION_SEPARATOR = " - ";

export function buildStatusEntries(carrierRuntime: CarrierRuntime): CarrierStatusEntry[] {
  const snapshot = readStatesSnapshot();
  return buildStatusEntriesFromSnapshot(carrierRuntime, snapshot);
}

export function buildStatusOverlayViewModel(
  entries: readonly CarrierStatusEntry[],
  selectedCarrierId: string | null,
): StatusOverlayViewModel {
  const groupedEntries = groupStatusEntries(entries);
  const flatEntries = groupedEntries.flatMap((group) => group.entries);
  return {
    flatEntries,
    groupedEntries,
    selectedCarrierId: resolveSelectedCarrierId(flatEntries, selectedCarrierId),
  };
}

export function resolveSelectedCarrierId(
  entries: readonly CarrierStatusEntry[],
  selectedCarrierId: string | null,
): string | null {
  if (entries.length === 0) return null;
  if (selectedCarrierId && entries.some((entry) => entry.carrierId === selectedCarrierId)) {
    return selectedCarrierId;
  }
  return entries[0]!.carrierId;
}

function groupStatusEntries(entries: readonly CarrierStatusEntry[]): GroupedEntries[] {
  const bucket = new Map<string, CarrierStatusEntry[]>();
  for (const entry of entries) {
    const key = entry.category ?? "uncategorized";
    const list = bucket.get(key) ?? [];
    list.push(entry);
    bucket.set(key, list);
  }

  for (const list of bucket.values()) {
    list.sort((a, b) => a.slot - b.slot);
  }

  const result: GroupedEntries[] = [];
  for (const category of CATEGORY_ORDER) {
    const categoryEntries = bucket.get(category);
    if (!categoryEntries?.length) continue;
    result.push({
      color: CATEGORY_COLORS[category],
      entries: categoryEntries,
      header: CATEGORY_LABELS[category],
    });
  }

  const uncategorized = bucket.get("uncategorized");
  if (uncategorized?.length) {
    result.push({
      color: CATEGORY_COLORS.uncategorized,
      entries: uncategorized,
      header: CATEGORY_LABELS.uncategorized,
    });
  }

  return result;
}

function buildStatusEntriesFromSnapshot(carrierRuntime: CarrierRuntime, snapshot: FleetStoreSnapshot): CarrierStatusEntry[] {
  const entries: CarrierStatusEntry[] = [];
  const registry = carrierRuntime.registry;
  const registeredOrder = getRegisteredOrder(registry);
  const subagentModes = readCarrierSubagentModeSnapshot().carrierModes;
  const cliTypesByCarrier = buildCliTypesByCarrierFromSnapshot(carrierRuntime, snapshot);
  loadModels(cliTypesByCarrier);
  const healedSnapshot = readStatesSnapshot();

  for (const id of registeredOrder) {
    const config = getCarrierConfig(registry, id);
    if (!config) continue;
    const cliType = cliTypeForCarrierFromSnapshot(healedSnapshot, id, config.defaultCliType as CarrierCliType);
    const selection = healedSnapshot.models[id];
    const provider = getProviderModelsEquivalent(cliType);
    const meta = config.carrierMetadata;
    const role = sanitizeCarrierMetadataText(meta?.title);
    const roleSummary = sanitizeCarrierMetadataText(meta?.summary);
    entries.push({
      carrierId: id,
      category: meta?.category,
      cliType,
      defaultCliType: config.defaultCliType as CarrierCliType,
      displayName: resolveCarrierDisplayName(registry, id),
      effort: selection?.effort ?? null,
      isDefault: !selection?.model,
      model: selection?.model || provider.defaultModel,
      role,
      roleDescription: buildRoleDescription(role, roleSummary),
      slot: config.slot,
      subagentMode: subagentModes[id] === "subagent",
      subagentPendingRestart: subagentModes[id] === "subagent",
      taskForceBackendCount: getConfiguredTaskForceBackendsFromSnapshot(healedSnapshot, id).length,
    });
  }

  return entries;
}

function buildCliTypesByCarrierFromSnapshot(carrierRuntime: CarrierRuntime, snapshot: FleetStoreSnapshot): Record<string, CarrierModelDefaults> {
  const registry = carrierRuntime.registry;
  return Object.fromEntries(
    getRegisteredOrder(registry)
      .map((id) => {
        const config = getCarrierConfig(registry, id);
        if (!config) return null;
        return [id, {
          cliType: cliTypeForCarrierFromSnapshot(snapshot, id, config.defaultCliType as CarrierCliType),
          ...(config.defaultEffort ? { defaultEffort: config.defaultEffort } : {}),
          ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
        }];
      })
      .filter((entry): entry is [string, CarrierModelDefaults] => entry !== null),
  );
}

function cliTypeForCarrierFromSnapshot(
  snapshot: FleetStoreSnapshot,
  carrierId: string,
  defaultCliType: CarrierCliType,
): CarrierCliType {
  return (snapshot.cliTypeOverrides[carrierId] as CarrierCliType | undefined) ?? defaultCliType;
}

function getProviderModelsEquivalent(cliType: CarrierCliType): CliModelInfo {
  try {
    const models = getCliModels(cliType).map((model) => ({
      modelId: model.id,
      name: model.name,
    }));
    const defaultModel = models[0]?.modelId ?? "default";
    const levels = getCliEffortLevels(cliType, defaultModel);
    return {
      defaultModel,
      effort: levels?.length ? { default: levels[0], levels, supported: true } : { supported: false },
      models,
      name: CLI_DISPLAY_NAMES[cliType] ?? cliType,
    };
  } catch {
    return {
      defaultModel: "default",
      effort: { supported: false },
      models: [],
      name: CLI_DISPLAY_NAMES[cliType] ?? cliType,
    };
  }
}

function buildRoleDescription(role: string | null, summary: string | null): string | null {
  if (role && summary) return `${role}${ROLE_DESCRIPTION_SEPARATOR}${summary}`;
  return role ?? summary;
}

function sanitizeCarrierMetadataText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sanitized = sanitizeToolBlockLabel(value).replace(/\s+/g, " ").trim();
  return sanitized || null;
}
