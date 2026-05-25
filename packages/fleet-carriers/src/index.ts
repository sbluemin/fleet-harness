import { registerDefaultCarriers } from "./agent-specs.js";
import { createCarrierRegistry, type CarrierRegistry } from "./dispatch/framework.js";
import * as dispatchFramework from "./dispatch/framework.js";
import * as dispatchStatusOverlay from "./dispatch/status-overlay.js";
import * as dispatchTaskforce from "./dispatch/taskforce.js";
import * as dispatchToolSpec from "./dispatch/tool-spec.js";
import * as dispatchTypes from "./dispatch/types.js";
import * as jobArchive from "./jobs/archive.js";
import * as jobDispatch from "./jobs/dispatch.js";
import * as jobLifecycle from "./jobs/lifecycle.js";
import * as jobSanitize from "./jobs/sanitize.js";
import * as jobTypes from "./jobs/types.js";
import * as carrierPersonas from "./personas/index.js";
import * as carrierStore from "./store/index.js";

export { registerDefaultCarriers } from "./agent-specs.js";
export * from "./constants.js";
export * as personas from "./personas/index.js";
export * as store from "./store/index.js";
export * from "./dispatch/framework.js";
export * from "./dispatch/status-overlay.js";
export * from "./dispatch/taskforce.js";
export * from "./dispatch/tool-spec.js";
export * from "./dispatch/types.js";
export { getActiveBackgroundJobCount } from "./jobs/lifecycle.js";
export * from "./jobs/archive.js";
export * from "./jobs/dispatch.js";
export * from "./jobs/lifecycle.js";
export * from "./jobs/sanitize.js";
export * from "./jobs/types.js";
export type {
  CarrierJobKind,
  CarrierJobStatus,
} from "./jobs/types.js";
export type {
  CarrierJobStreamEvent,
  CarrierJobStreamHandler,
  CarrierJobKind as CarrierStreamJobKind,
  CarrierJobStatus as CarrierStreamJobStatus,
  TrackMeta,
  TrackKind,
  TrackStatus,
} from "./dispatch/types.js";
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
  dispatch: typeof dispatch;
  jobs: ReturnType<typeof createBoundCarrierJobs>;
  personas: typeof carrierPersonas;
  store: typeof carrierStore;
  stream: ReturnType<typeof createBoundCarrierStream>;
  registerCarrierDefaults(): void;
}

export const dispatch = {
  ...dispatchFramework,
  framework: dispatchFramework,
  statusOverlayController: dispatchStatusOverlay,
  taskforce: dispatchTaskforce,
  toolSpec: dispatchToolSpec,
  types: dispatchTypes,
  buildToolSpecs: dispatchToolSpec.buildCarrierDispatchToolSpec,
};

export const carrier = dispatch;

export const taskforce = dispatchTaskforce;

export const stream = {
  emitStreamEvent: dispatchFramework.emitStreamEvent,
  registerStreamHandler: dispatchFramework.registerStreamHandler,
  unregisterStreamHandler: dispatchFramework.unregisterStreamHandler,
};

export const jobs = {
  archive: jobArchive,
  dispatch: jobDispatch,
  lifecycle: jobLifecycle,
  sanitize: jobSanitize,
  types: jobTypes,
  jobTypes,
  prompts: jobDispatch,
  buildToolSpec: jobDispatch.buildCarrierJobsToolSpec,
  configureJobSummaryCache: jobDispatch.configureJobSummaryCache,
  detachJobArchive: jobArchive.detachJobArchive,
  acquireJobPermit: jobLifecycle.acquireJobPermit,
  getActiveBackgroundJobCount: jobLifecycle.getActiveBackgroundJobCount,
  onActiveJobCountChange: jobLifecycle.onActiveJobCountChange,
  resetJobConcurrencyForTest: jobLifecycle.resetJobConcurrencyForTest,
  streaming: {
    register: dispatchFramework.registerStreamHandler,
    unregister: dispatchFramework.unregisterStreamHandler,
    emit: dispatchFramework.emitStreamEvent,
  },
};

export const carrierJobs = jobs;

export function createCarrierRuntime(): CarrierRuntime {
  const registry = createCarrierRegistry();
  const boundStream = createBoundCarrierStream(registry);
  const boundCarrierJobs = createBoundCarrierJobs(registry, boundStream);
  return {
    registry,
    dispatch,
    jobs: boundCarrierJobs,
    personas: carrierPersonas,
    store: carrierStore,
    stream: boundStream,
    registerCarrierDefaults() {
      registerDefaultCarriers(registry);
    },
  };
}

function createBoundCarrierStream(registry: CarrierRegistry) {
  return {
    register(handler: dispatchTypes.CarrierJobStreamHandler): () => void {
      return dispatchFramework.registerStreamHandler(registry, handler);
    },
    unregister(handler: dispatchTypes.CarrierJobStreamHandler): void {
      dispatchFramework.unregisterStreamHandler(registry, handler);
    },
    emit(event: dispatchTypes.CarrierJobStreamEvent): void {
      dispatchFramework.emitStreamEvent(registry, event);
    },
  };
}

function createBoundCarrierJobs(
  registry: CarrierRegistry,
  boundStream = createBoundCarrierStream(registry),
) {
  return {
    ...jobs,
    streaming: boundStream,
  };
}
