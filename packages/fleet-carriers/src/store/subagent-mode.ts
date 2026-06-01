import { sanitizeCarrierModes, sanitizeConfigKey } from "./sanitize.js";
import { assertUniqueCodexSubagentRoleKeys, buildCodexSubagentDefinition } from "../subagents/codex.js";
import { ensureCodexSubagentRoleFile, removeCodexSubagentRoleFile } from "./codex-subagent-files.js";
import { readStatesSnapshot, updateStates } from "./state-io.js";
import type { CarrierConfig } from "../dispatch/types.js";
import type { CarrierSubagentModeSnapshot, PerCliSettings } from "./types.js";

export interface SetCarrierSubagentModeWithCodexRoleOptions {
  readonly enabledCarrierIds?: readonly string[];
  readonly registeredCarrierIds?: readonly string[];
}

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

export function setCarrierSubagentModeWithCodexRole(
  config: CarrierConfig,
  enabled: boolean,
  codexSettings?: PerCliSettings,
  options?: SetCarrierSubagentModeWithCodexRoleOptions,
): void {
  const definition = buildCodexSubagentDefinition(config, codexSettings);
  if (enabled) {
    assertCodexSubagentRoleKeyDoesNotCollide(config.id, options);
    ensureCodexSubagentRoleFile(definition);
    try {
      setCarrierSubagentMode(config.id, true);
    } catch (error) {
      removeCodexSubagentRoleFile(definition.roleKey);
      throw error;
    }
  } else {
    removeCodexSubagentRoleFile(definition.roleKey);
    try {
      setCarrierSubagentMode(config.id, false);
    } catch (error) {
      ensureCodexSubagentRoleFile(definition);
      throw error;
    }
  }
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

function assertCodexSubagentRoleKeyDoesNotCollide(
  carrierId: string,
  options?: SetCarrierSubagentModeWithCodexRoleOptions,
): void {
  const enabledCarrierIds = options?.enabledCarrierIds
    ?? getEnabledCarrierSubagentIds(readCarrierSubagentModeSnapshot(), options?.registeredCarrierIds);
  assertUniqueCodexSubagentRoleKeys([...new Set([...enabledCarrierIds, carrierId])]);
}
