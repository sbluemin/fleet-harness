import { registerDefaultCarriers } from "./agent-specs.js";
import type { AgentCliLaunchResolver, AgentToolCtx, AgentToolSpec } from "@dotobokuri/core-agent";
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
export * from "./dispatch/framework.js";
export * from "./dispatch/context-registry.js";
export * from "./dispatch/prompt.js";
export * from "./dispatch/readiness.js";
export * from "./dispatch/status-overlay.js";
export * from "./dispatch/taskforce-policy.js";
export * from "./dispatch/taskforce.js";
export * from "./dispatch/tool-spec.js";
export * from "./dispatch/types.js";
export * from "./i18n/carrier-presentations.js";
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
  updateAgentCliTypeOverride,
  applyAgentCliTypeSelectionUpdate,
  loadCarrierDisplayNameOverrides,
  updateCarrierDisplayName,
  normalizeCarrierDisplayNameInput,
  sanitizeCarrierDisplayName,
  readCarriersSnapshot,
  getCarriersFilePath,
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
  setAgentCliLaunchResolver(resolver: AgentCliLaunchResolver): void;
  jobs: ReturnType<typeof createBoundCarrierJobs>;
  personas: typeof carrierPersonas;
  store: CarrierRuntimeStore;
  stream: ReturnType<typeof createBoundCarrierStream>;
  trackInFlight(task: RuntimeInFlightTask): () => void;
  cleanup(): Promise<void>;
  registerCarrierDefaults(): void;
}

/** Host lifecycle needs durable-store initialization, not store mutation internals. */
export interface CarrierRuntimeStore {
  initStore: typeof carrierStore.initStore;
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
  resetJobTrackingForTest: jobLifecycle.resetJobTrackingForTest,
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
  let agentCliLaunchResolver: AgentCliLaunchResolver | undefined;
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
      return boundDispatch.buildToolSpecs({
        ...deps,
        // host가 lifecycle 생성 뒤 resolver를 주입해도 이미 등록된 단일 dispatch 도구가
        // 실행 직전 최신 resolver를 읽도록 runtime 소유 closure로 연결한다.
        agentCliLaunchResolver: async (cli, context) => {
          const resolver = agentCliLaunchResolver ?? deps.agentCliLaunchResolver;
          return resolver ? resolver(cli, context) : {};
        },
      });
    },
    jobs: boundCarrierJobs,
    personas: carrierPersonas,
    store: { initStore: carrierStore.initStore },
    stream: boundStream,
    setAgentCliLaunchResolver(resolver) {
      agentCliLaunchResolver = resolver;
    },
    trackInFlight: dispatchServices.trackInFlight,
    async cleanup() {
      accepting = false;
      const tasks = [...inFlight];
      await Promise.allSettled(tasks.map((task) => task.cancel()));
      await Promise.allSettled(tasks.map((task) => task.completion));
      inFlight.clear();
      agentCliLaunchResolver = undefined;
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
      return Object.defineProperties({}, {
        ...Object.getOwnPropertyDescriptors(toolSpec),
        execute: {
          configurable: true,
          enumerable: true,
          writable: true,
          value(args: unknown, ctx: AgentToolCtx) {
            services.admission.assertOpen();
            return toolSpec.execute(args, ctx);
          },
        },
      }) as AgentToolSpec;
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
