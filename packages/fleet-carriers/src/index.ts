import { registerDefaultCarriers } from "./agent-specs.js";
import { createCarrierRegistry, type CarrierRegistry } from "./dispatch/framework.js";
import * as carrierDispatch from "./dispatch/index.js";
import * as carrierJobs from "./jobs/index.js";
import * as carrierPersonas from "./personas/index.js";
import * as carrierStore from "./store/index.js";
import * as carrierStream from "./stream/index.js";

export { registerDefaultCarriers } from "./agent-specs.js";
export * from "./constants.js";
export * as dispatch from "./dispatch/index.js";
export * as carrier from "./dispatch/index.js";
export * as taskforce from "./dispatch/index.js";
export * as jobs from "./jobs/index.js";
export * as carrierJobs from "./jobs/index.js";
export * as personas from "./personas/index.js";
export * as store from "./store/index.js";
export * as stream from "./stream/index.js";
export * from "./dispatch/index.js";
export { getActiveBackgroundJobCount } from "./jobs/index.js";
export * from "./jobs/index.js";
export {
  emitStreamEvent,
  registerStreamHandler,
  unregisterStreamHandler,
} from "./stream/index.js";
export type {
  CarrierJobStreamEvent,
  CarrierJobStreamHandler,
  TrackMeta,
  TrackKind,
  TrackStatus,
} from "./stream/index.js";
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
  jobs: typeof carrierJobs;
  personas: typeof carrierPersonas;
  store: typeof carrierStore;
  stream: typeof carrierStream;
  registerCarrierDefaults(): void;
}

export function createCarrierRuntime(): CarrierRuntime {
  const registry = createCarrierRegistry();
  return {
    registry,
    dispatch: carrierDispatch,
    jobs: carrierJobs,
    personas: carrierPersonas,
    store: carrierStore,
    stream: carrierStream,
    registerCarrierDefaults() {
      registerDefaultCarriers(registry);
    },
  };
}
