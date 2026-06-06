import { sanitizeConfigKey } from "./sanitize.js";
import { buildHealedCarriers } from "./models.js";
import { readRawCarriers, updateCarriers } from "./state-io.js";
import type { CarrierAgentMode, CarrierAgentModeSnapshot } from "./types.js";
import type { CarrierModelDefaults } from "./models.js";

export function readCarrierAgentModeSnapshot(
  defaultsByCarrier: Record<string, CarrierModelDefaults> = {},
): CarrierAgentModeSnapshot {
  const raw = readRawCarriers();
  const carriers = buildHealedCarriers(defaultsByCarrier);
  return {
    agentModes: Object.fromEntries(
      Object.entries(carriers)
        .filter(([, state]) => state.agentMode === "subagent")
        .map(([id]) => [id, "subagent" as const]),
    ),
    generation: raw._meta?.generation ?? 0,
  };
}

export function isCarrierAgentModeSubagent(
  carrierId: string,
  defaultAgentMode: CarrierAgentMode = "cli",
): boolean {
  const rawMode = readRawCarriers().carriers?.[carrierId]?.agentMode;
  return (rawMode ?? defaultAgentMode) === "subagent";
}

export function setCarrierAgentMode(
  carrierId: string,
  enabled: boolean,
  defaultAgentMode: CarrierAgentMode = "cli",
): void {
  const sanitizedCarrierId = sanitizeConfigKey(carrierId);
  if (!sanitizedCarrierId) return;
  const nextAgentMode: CarrierAgentMode = enabled ? "subagent" : "cli";

  updateCarriers((states) => {
    const carriers = { ...(states.carriers ?? {}) };
    const current = carriers[sanitizedCarrierId] ?? {};
    const next = { ...current };
    if (nextAgentMode === defaultAgentMode) delete next.agentMode;
    else next.agentMode = nextAgentMode;
    carriers[sanitizedCarrierId] = next;
    states.carriers = carriers;
  });
}

export function filterCarrierAgentModesToRegisteredIds(
  snapshot: CarrierAgentModeSnapshot,
  registeredCarrierIds: readonly string[],
): CarrierAgentModeSnapshot {
  const allowed = new Set(registeredCarrierIds);
  return {
    agentModes: Object.fromEntries(
      Object.entries(snapshot.agentModes).filter(([carrierId]) => allowed.has(carrierId)),
    ),
    generation: snapshot.generation,
  };
}

export function getEnabledCarrierSubagentIds(
  snapshot: CarrierAgentModeSnapshot,
  registeredCarrierIds?: readonly string[],
): string[] {
  const filtered = registeredCarrierIds
    ? filterCarrierAgentModesToRegisteredIds(snapshot, registeredCarrierIds)
    : snapshot;
  return Object.keys(filtered.agentModes).sort();
}
