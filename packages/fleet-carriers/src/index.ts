import { registerDefaultCarriers } from "./agent-specs.js";
import type { AgentToolCtx, AgentToolSpec } from "@dotobokuri/core-agent";
import { createCarrierRegistry, type CarrierRegistry } from "./dispatch/framework.js";
import * as dispatchFramework from "./dispatch/framework.js";
import { DispatchContextRegistry } from "./dispatch/context-registry.js";
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

export { DEFAULT_CARRIER_COUNT, registerDefaultCarriers } from "./agent-specs.js";
export * from "./constants.js";
export * as personas from "./personas/index.js";
export * as store from "./store/index.js";
export * from "./dispatch/framework.js";
export * from "./dispatch/context-registry.js";
export * from "./dispatch/prompt.js";
export * from "./dispatch/readiness.js";
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
export * from "./jobs/workspace-manifest.js";
export type {
  CarrierJobKind,
  CarrierJobStatus,
} from "./jobs/types.js";
export type {
  CarrierJobStreamEvent,
  CarrierJobStreamHandler,
  TrackMeta,
  TrackKind,
  TrackStatus,
} from "./dispatch/types.js";
export {
  initStore,
  loadCarrierStates,
  updateAgentCliSelection,
  getAgentCliSelection,
  saveAgentCliSelection,
  getTaskForceModelConfig,
  updateTaskForceModelSelection,
  resetTaskForceModelSelection,
  resetCarrierTaskForceConfig,
  getConfiguredTaskForceBackends,
  getConfiguredTaskForceBackendsFromSnapshot,
  getConfiguredTaskForceCarrierIds,
  getConfiguredTaskForceCarrierIdsFromSnapshot,
  updateAgentCliTypeOverride,
  applyAgentCliTypeSelectionUpdate,
  loadCarrierDisplayNameOverrides,
  updateCarrierDisplayName,
  normalizeCarrierDisplayNameInput,
  sanitizeCarrierDisplayName,
  readCarriersSnapshot,
  getCarriersFilePath,
  updateCarriers,
  withStoreLock,
  resetStoreForTests,
} from "./store/index.js";
export type {
  AgentCliSelection,
  CarrierState,
  FleetStoreSnapshot,
  FleetStoreWriteFingerprint,
  CarrierModelDefaults,
  ResolvedCarrierState,
} from "./store/index.js";
export * from "./personas/index.js";

export interface CarrierRuntime {
  registry: CarrierRegistry;
  dispatchContexts: DispatchContextRegistry;
  admission: RuntimeDispatchAdmission;
  dispatchServices: CarrierDispatchServices;
  dispatch: ReturnType<typeof createBoundCarrierDispatch>;
  buildDispatchToolSpec(deps: Parameters<typeof dispatchToolSpec.buildCarrierDispatchToolSpec>[1]): ReturnType<typeof dispatchToolSpec.buildCarrierDispatchToolSpec>;
  jobs: ReturnType<typeof createBoundCarrierJobs>;
  personas: typeof carrierPersonas;
  store: typeof carrierStore;
  stream: ReturnType<typeof createBoundCarrierStream>;
  trackInFlight(task: RuntimeInFlightTask): () => void;
  cleanup(): Promise<void>;
  registerCarrierDefaults(): void;
}

export interface RuntimeInFlightTask {
  cancel(): void | Promise<void>;
  completion: Promise<unknown>;
}

/** Runtime-local admission boundary for every detached Carrier dispatch. */
export interface RuntimeDispatchAdmission {
  readonly accepting: boolean;
  assertOpen(): void;
}

/** The only runtime-owned state W2 dispatch construction may consume. */
export interface CarrierDispatchServices {
  readonly dispatchContexts: DispatchContextRegistry;
  readonly admission: RuntimeDispatchAdmission;
  trackInFlight(task: RuntimeInFlightTask): () => void;
}

/** W2 may adopt the optional third argument without changing today's builder contract. */
export type CarrierDispatchToolBuilder = (
  registry: CarrierRegistry,
  deps: Parameters<typeof dispatchToolSpec.buildCarrierDispatchToolSpec>[1],
  services?: CarrierDispatchServices,
) => AgentToolSpec;

export const dispatch = {
  ...dispatchFramework,
  framework: dispatchFramework,
  statusOverlayController: dispatchStatusOverlay,
  taskforce: dispatchTaskforce,
  toolSpec: dispatchToolSpec,
  types: dispatchTypes,
  buildToolSpecs: dispatchToolSpec.buildCarrierDispatchToolSpec,
};

export const jobs = {
  archive: jobArchive,
  dispatch: jobDispatch,
  lifecycle: jobLifecycle,
  sanitize: jobSanitize,
  types: jobTypes,
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

export function createCarrierRuntime(): CarrierRuntime {
  const registry = createCarrierRegistry();
  const dispatchContexts = new DispatchContextRegistry();
  const inFlight = new Set<RuntimeInFlightTask>();
  let accepting = true;
  const admission: RuntimeDispatchAdmission = {
    get accepting() {
      return accepting;
    },
    assertOpen() {
      if (!accepting) throw new Error("Carrier runtime is closed to new dispatches.");
    },
  };
  const dispatchServices: CarrierDispatchServices = {
    dispatchContexts,
    admission,
    trackInFlight(task) {
      admission.assertOpen();
      inFlight.add(task);
      return () => inFlight.delete(task);
    },
  };
  const boundDispatch = createBoundCarrierDispatch(registry, dispatchServices);
  const boundStream = createBoundCarrierStream(registry);
  const boundCarrierJobs = createBoundCarrierJobs(registry, boundStream);
  return {
    registry,
    dispatchContexts,
    admission,
    dispatchServices,
    dispatch: boundDispatch,
    buildDispatchToolSpec(deps) {
      return boundDispatch.buildToolSpecs(deps);
    },
    jobs: boundCarrierJobs,
    personas: carrierPersonas,
    store: carrierStore,
    stream: boundStream,
    trackInFlight: dispatchServices.trackInFlight,
    async cleanup() {
      accepting = false;
      const tasks = [...inFlight];
      await Promise.allSettled(tasks.map((task) => task.cancel()));
      await Promise.allSettled(tasks.map((task) => task.completion));
      inFlight.clear();
      dispatchContexts.dispose();
    },
    registerCarrierDefaults() {
      registerDefaultCarriers(registry);
    },
  };
}

function createBoundCarrierDispatch(registry: CarrierRegistry, services: CarrierDispatchServices) {
  return {
    ...dispatch,
    buildToolSpecs(deps: Parameters<typeof dispatchToolSpec.buildCarrierDispatchToolSpec>[1]) {
      services.admission.assertOpen();
      const builder: CarrierDispatchToolBuilder = dispatchToolSpec.buildCarrierDispatchToolSpec;
      const toolSpec = builder(registry, deps, services);
      return {
        ...toolSpec,
        execute(args: unknown, ctx: AgentToolCtx) {
          services.admission.assertOpen();
          return toolSpec.execute(args, ctx);
        },
      };
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
