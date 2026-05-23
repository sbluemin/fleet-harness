interface CancelState {
  controllers: Map<string, Set<AbortController>>;
}

export interface JobCancelRegistry {
  registerJobAbortController(jobId: string, controller: AbortController): void;
  unregisterJobAbortControllers(jobId: string): void;
  cancelJob(jobId: string): CancelResult;
  hasJobCancelControllers(jobId: string): boolean;
  resetJobCancelRegistryForTest(): void;
}

export interface CancelResult {
  cancelled: boolean;
  status: "cancelled" | "not_found";
}

const defaultJobCancelRegistry = createJobCancelRegistry();

export function createJobCancelRegistry(): JobCancelRegistry {
  const state: CancelState = { controllers: new Map() };

  return {
    registerJobAbortController(jobId, controller) {
      const existing = state.controllers.get(jobId) ?? new Set<AbortController>();
      existing.add(controller);
      state.controllers.set(jobId, existing);
    },
    unregisterJobAbortControllers(jobId) {
      state.controllers.delete(jobId);
    },
    cancelJob(jobId) {
      const controllers = state.controllers.get(jobId);
      if (!controllers || controllers.size === 0) return { cancelled: false, status: "not_found" };
      for (const controller of controllers) {
        controller.abort();
      }
      return { cancelled: true, status: "cancelled" };
    },
    hasJobCancelControllers(jobId) {
      const controllers = state.controllers.get(jobId);
      return Boolean(controllers && controllers.size > 0);
    },
    resetJobCancelRegistryForTest() {
      state.controllers.clear();
    },
  };
}

export function registerJobAbortController(jobId: string, controller: AbortController): void {
  defaultJobCancelRegistry.registerJobAbortController(jobId, controller);
}

export function unregisterJobAbortControllers(jobId: string): void {
  defaultJobCancelRegistry.unregisterJobAbortControllers(jobId);
}

export function cancelJob(jobId: string): CancelResult {
  return defaultJobCancelRegistry.cancelJob(jobId);
}

export function hasJobCancelControllers(jobId: string): boolean {
  return defaultJobCancelRegistry.hasJobCancelControllers(jobId);
}

export function resetJobCancelRegistryForTest(): void {
  defaultJobCancelRegistry.resetJobCancelRegistryForTest();
}
