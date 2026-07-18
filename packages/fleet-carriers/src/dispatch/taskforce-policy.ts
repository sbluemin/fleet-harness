import type { FleetStoreSnapshot, TaskForceSelection } from "../store/index.js";
import {
  getConfiguredTaskForceBackends,
  getConfiguredTaskForceBackendsFromSnapshot,
  resetCarrierTaskForceConfig,
  resetTaskForceModelSelection,
  updateTaskForceModelSelection,
} from "../store/taskforce-config.js";
import { getRegisteredCarrierConfig, type CarrierRegistry } from "./framework.js";
import type { TaskForceCliType } from "./types.js";

/** The package-owned minimum number of effective Task Force backends. */
export const TASKFORCE_MIN_BACKENDS = 2;

export function isTaskForceCapable(registry: CarrierRegistry, carrierId: string): boolean {
  return getRegisteredCarrierConfig(registry, carrierId)?.taskForceCapable === true;
}

export function getEffectiveTaskForceBackends(
  registry: CarrierRegistry,
  carrierId: string,
  snapshot?: FleetStoreSnapshot,
): TaskForceCliType[] {
  if (!isTaskForceCapable(registry, carrierId)) return [];
  return snapshot
    ? getConfiguredTaskForceBackendsFromSnapshot(snapshot, carrierId)
    : getConfiguredTaskForceBackends(carrierId);
}

export function isTaskForceFormable(
  registry: CarrierRegistry,
  carrierId: string,
  snapshot?: FleetStoreSnapshot,
): boolean {
  return getEffectiveTaskForceBackends(registry, carrierId, snapshot).length >= TASKFORCE_MIN_BACKENDS;
}

export function setTaskForceBackend(
  registry: CarrierRegistry,
  carrierId: string,
  cliType: string,
  selection: TaskForceSelection,
): void {
  if (!getRegisteredCarrierConfig(registry, carrierId)) throw new Error("carrier_not_found");
  if (!isTaskForceCapable(registry, carrierId)) throw new Error("taskforce_not_capable");
  updateTaskForceModelSelection(carrierId, cliType, selection);
}

/** Registry-free cleanup deliberately preserves removability of stale overrides. */
export function removeTaskForceBackend(carrierId: string, cliType: string): void {
  resetTaskForceModelSelection(carrierId, cliType);
}

/** Registry-free cleanup deliberately preserves removability of stale overrides. */
export function clearTaskForceConfig(carrierId: string): boolean {
  return resetCarrierTaskForceConfig(carrierId);
}
