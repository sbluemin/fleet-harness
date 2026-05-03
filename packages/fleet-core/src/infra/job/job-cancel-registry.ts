interface CancelState {
  controllers: Map<string, Set<AbortController>>;
}

export interface CancelResult {
  cancelled: boolean;
  status: "cancelled" | "not_found";
}

const CANCEL_STATE_KEY = "__pi_fleet_job_cancel_registry__";

export function registerJobAbortController(jobId: string, controller: AbortController): void {
  const state = getCancelState();
  const existing = state.controllers.get(jobId) ?? new Set<AbortController>();
  existing.add(controller);
  state.controllers.set(jobId, existing);
}

export function unregisterJobAbortControllers(jobId: string): void {
  getCancelState().controllers.delete(jobId);
}

export function cancelJob(jobId: string): CancelResult {
  const controllers = getCancelState().controllers.get(jobId);
  if (!controllers || controllers.size === 0) return { cancelled: false, status: "not_found" };
  for (const controller of controllers) {
    controller.abort();
  }
  return { cancelled: true, status: "cancelled" };
}

export function hasJobCancelControllers(jobId: string): boolean {
  const controllers = getCancelState().controllers.get(jobId);
  return Boolean(controllers && controllers.size > 0);
}

export function resetJobCancelRegistryForTest(): void {
  getCancelState().controllers.clear();
}

function getCancelState(): CancelState {
  const root = globalThis as Record<string, unknown>;
  const existing = root[CANCEL_STATE_KEY] as CancelState | undefined;
  if (existing) return existing;
  const state: CancelState = { controllers: new Map() };
  root[CANCEL_STATE_KEY] = state;
  return state;
}
