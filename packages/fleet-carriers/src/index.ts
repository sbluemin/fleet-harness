import { registerDefaultCarriers } from "./agent-specs.js";
import { createCarrierRegistry, type CarrierRegistry } from "./dispatch/framework.js";
import * as carrierDispatch from "./dispatch/index.js";
import * as carrierEvents from "./events/index.js";
import * as job from "./job/index.js";
import * as carrierJobs from "./jobs/index.js";
import * as carrierStore from "./store/index.js";

export { registerDefaultCarriers } from "./agent-specs.js";
export * from "./constants.js";
export * as dispatch from "./dispatch/index.js";
export * as carrier from "./dispatch/index.js";
export * as taskforce from "./dispatch/index.js";
export * as job from "./job/index.js";
export * as jobs from "./jobs/index.js";
export * as carrierJobs from "./jobs/index.js";
export * as store from "./store/index.js";
export * as events from "./events/index.js";
export * from "./dispatch/index.js";
export { getActiveBackgroundJobCount } from "./job/index.js";
export * from "./jobs/index.js";
export * from "./events/index.js";
export {
  initStore,
  loadModels,
  updateModelSelection,
  getPerCliSettings,
  savePerCliSettings,
  getTaskForceModelConfig,
  updateTaskForceModelSelection,
  resetTaskForceModelSelection,
  getConfiguredTaskForceBackends,
  getConfiguredTaskForceBackendsFromSnapshot,
  getConfiguredTaskForceCarrierIds,
  getConfiguredTaskForceCarrierIdsFromSnapshot,
  loadCliTypeOverrides,
  updateCliTypeOverride,
  applyCliTypeModelSelectionUpdate,
  loadCarrierDisplayNames,
  updateCarrierDisplayName,
  normalizeCarrierDisplayNameInput,
  sanitizeCarrierDisplayName,
  readStatesSnapshot,
  getLastLocalStatesGeneration,
  getLastLocalWriteFingerprint,
  getStatesFilePath,
  updateStates,
  withStoreLock,
  resetStoreForTests,
} from "./store/index.js";
export type {
  FleetStoreSnapshot,
  FleetStoreWriteFingerprint,
  SelectedModelsConfig,
} from "./store/index.js";
export * from "./personas/index.js";

export interface CarrierRuntime {
  registry: CarrierRegistry;
  dispatch: typeof carrierDispatch;
  events: typeof carrierEvents;
  jobs: typeof carrierJobs;
  store: typeof carrierStore;
  registerCarrierDefaults(): void;
}

export interface CarrierRuntimeDeps {
  readonly config?: Record<string, never>;
}

export function createCarrierRuntime(_deps: CarrierRuntimeDeps = {}): CarrierRuntime {
  const registry = createCarrierRegistry();
  return {
    registry,
    dispatch: carrierDispatch,
    events: carrierEvents,
    jobs: carrierJobs,
    store: carrierStore,
    registerCarrierDefaults() {
      registerDefaultCarriers(registry);
    },
  };
}
