import { sanitizeCarrierModes, sanitizeConfigKey } from "./sanitize.js";
import { readStatesSnapshot, updateStates } from "./state-io.js";
import type { CarrierSubagentModeSnapshot } from "./types.js";

export function readCarrierSubagentModeSnapshot(): CarrierSubagentModeSnapshot {
  const snapshot = readStatesSnapshot();
  return {
    carrierModes: snapshot.carrierModes,
    generation: snapshot.generation,
  };
}

export function isCarrierSubagentModeEnabled(carrierId: string): boolean {
  return readCarrierSubagentModeSnapshot().carrierModes[carrierId] === "subagent";
}

export function setCarrierSubagentMode(carrierId: string, enabled: boolean): void {
  const sanitizedCarrierId = sanitizeConfigKey(carrierId);
  if (!sanitizedCarrierId) return;

  updateStates((states) => {
    const carrierModes = { ...sanitizeCarrierModes(states.carrierModes) };
    if (enabled) carrierModes[sanitizedCarrierId] = "subagent";
    else delete carrierModes[sanitizedCarrierId];

    if (Object.keys(carrierModes).length > 0) {
      states.carrierModes = carrierModes;
    } else {
      delete states.carrierModes;
    }
  });
}

export function filterCarrierSubagentModesToRegisteredIds(
  snapshot: CarrierSubagentModeSnapshot,
  registeredCarrierIds: readonly string[],
): CarrierSubagentModeSnapshot {
  const allowed = new Set(registeredCarrierIds);
  return {
    carrierModes: Object.fromEntries(
      Object.entries(snapshot.carrierModes).filter(([carrierId]) => allowed.has(carrierId)),
    ),
    generation: snapshot.generation,
  };
}

export function getEnabledCarrierSubagentIds(
  snapshot: CarrierSubagentModeSnapshot,
  registeredCarrierIds?: readonly string[],
): string[] {
  const filtered = registeredCarrierIds
    ? filterCarrierSubagentModesToRegisteredIds(snapshot, registeredCarrierIds)
    : snapshot;
  return Object.keys(filtered.carrierModes).sort();
}
