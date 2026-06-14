import { getProviderModels } from "@dotobokuri/core-unified-agent";

import { sanitizeToolBlockLabel } from "../jobs/sanitize.js";
import {
  getConfiguredTaskForceBackendsFromSnapshot,
  readCarriersSnapshot,
  readFileBackedCarriersSnapshot,
} from "../store/index.js";
import type { CarrierModelDefaults, FleetStoreSnapshot } from "../store/index.js";

import {
  getCarrierSourceDisplayName,
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  resolveAgentCliType,
  type CarrierRegistry,
} from "./framework.js";
import { buildCarrierModelDefaults } from "./status-overlay.js";
import type { CarrierConfig, CarrierStatusEntry, CarrierCliType } from "./types.js";

const ROLE_DESCRIPTION_SEPARATOR = " - ";

export function buildCarrierStatusEntries(registry: CarrierRegistry): CarrierStatusEntry[] {
  const carrierDefaults = buildCarrierDefaultsByCarrier(registry);
  return buildCarrierStatusEntriesFromSnapshot(registry, readCarriersSnapshot(carrierDefaults));
}

export function readCarrierStatusEntries(registry: CarrierRegistry): CarrierStatusEntry[] {
  const carrierDefaults = buildCarrierDefaultsByCarrier(registry);
  return buildCarrierStatusEntriesFromSnapshot(registry, readFileBackedCarriersSnapshot(carrierDefaults));
}

function buildCarrierStatusEntriesFromSnapshot(registry: CarrierRegistry, snapshot: FleetStoreSnapshot): CarrierStatusEntry[] {
  const entries: CarrierStatusEntry[] = [];

  for (const carrierId of getRegisteredOrder(registry)) {
    const config = getRegisteredCarrierConfig(registry, carrierId);
    if (!config) continue;
    const state = snapshot.carriers[carrierId];
    const cliType = snapshot.carriers[carrierId]?.agentCliType ?? config.defaultCliType as CarrierCliType;
    const selection = snapshot.carriers[carrierId]?.agentCli[cliType];
    const provider = getProviderModels(cliType);
    const role = sanitizeCarrierMetadataText(config.carrierMetadata?.title);
    const roleSummary = sanitizeCarrierMetadataText(config.carrierMetadata?.summary);
    entries.push({
      carrierId,
      category: config.carrierMetadata?.category,
      cliType,
      defaultCliType: config.defaultCliType as CarrierCliType,
      displayName: state?.displayName ?? getCarrierSourceDisplayName(registry, carrierId),
      effort: selection?.effort ?? null,
      isDefault: !selection?.model,
      model: selection?.model || provider.defaultModel,
      role,
      roleDescription: buildRoleDescription(role, roleSummary),
      slot: config.slot,
      subagentMode: state?.agentMode === "subagent",
      taskForceBackendCount: getConfiguredTaskForceBackendsFromSnapshot(snapshot, carrierId).length,
    });
  }

  return entries;
}

function buildCarrierDefaultsByCarrier(registry: CarrierRegistry): Record<string, CarrierModelDefaults> {
  return Object.fromEntries(
    getRegisteredOrder(registry)
      .map((carrierId) => {
        const config = getRegisteredCarrierConfig(registry, carrierId);
        if (!config) return null;
        return [carrierId, buildCarrierDefaults(config)] as const;
      })
      .filter((entry): entry is readonly [string, CarrierModelDefaults] => entry !== null),
  );
}

function buildCarrierDefaults(config: CarrierConfig): CarrierModelDefaults {
  const cliType = resolveAgentCliType(config.id, config.defaultCliType);
  const cliDefaults = buildCarrierModelDefaults(config, cliType);
  return {
    cliType,
    ...(config.defaultAgentMode ? { defaultAgentMode: config.defaultAgentMode } : {}),
    ...(cliDefaults.defaultEffort ? { defaultEffort: cliDefaults.defaultEffort } : {}),
    ...(cliDefaults.defaultModel ? { defaultModel: cliDefaults.defaultModel } : {}),
  };
}

function buildRoleDescription(role: string | null, summary: string | null): string | null {
  if (role && summary) return `${role}${ROLE_DESCRIPTION_SEPARATOR}${summary}`;
  return role ?? summary;
}

function sanitizeCarrierMetadataText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sanitized = sanitizeToolBlockLabel(value).trim();
  return sanitized.length > 0 ? sanitized : null;
}
