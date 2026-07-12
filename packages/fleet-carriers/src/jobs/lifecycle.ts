import type { CarrierJobFinalStatus, CarrierJobKind, CarrierJobLaunchResponse, CarrierJobRecord, CarrierJobSummary } from "./types.js";
import { buildCarrierJobId, formatLaunchResponseText } from "./types.js";
import { createJobArchive, finalizeJobArchive } from "./archive.js";
import { detachJobArchive } from "./archive.js";
import { putJobSummary } from "./summary-cache.js";

interface GuardState {
  activeJobs: Map<string, CarrierJobRecord>;
  activeCarrierJobs: Map<string, Set<string>>;
  maxDetachedJobs: number;
  activeJobCountCallbacks: Array<(count: number) => void>;
}

interface CancelState {
  controllers: Map<string, Set<AbortController>>;
}

export interface JobPermitAccepted {
  accepted: true;
  release: (finished?: Partial<Pick<CarrierJobRecord, "status" | "error" | "finishedAt">>) => void;
}

export interface JobPermitRejected {
  accepted: false;
  error: "concurrency limit";
}

export type JobPermit = JobPermitAccepted | JobPermitRejected;

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

export interface DetachedJobAccepted {
  accepted: true;
  jobId: string;
  permit: JobPermitAccepted;
  signal: AbortSignal;
}

export interface DetachedJobRejected {
  accepted: false;
  response: ReturnType<typeof launchResponseResult>;
}

export type DetachedJobLaunch = DetachedJobAccepted | DetachedJobRejected;

export interface StartDetachedJobOptions {
  jobKind: CarrierJobKind;
  toolName: `carrier_${string}`;
  toolCallId: string | undefined;
  startedAt: number;
  carrierIds: string[];
  signal: AbortSignal | undefined;
}

export interface FinalizeDetachedJobOptions {
  jobId: string;
  status: CarrierJobFinalStatus;
  error: string | undefined;
  finishedAt: number;
  summary: CarrierJobSummary;
  permit: JobPermitAccepted;
}

export interface RollbackRejectedDetachedJobOptions {
  jobId: string;
  permit: JobPermitAccepted;
  abort?: () => void | Promise<void>;
}

const DEFAULT_MAX_DETACHED_JOBS = 5;
const guardState: GuardState = {
  activeJobs: new Map(),
  activeCarrierJobs: new Map(),
  maxDetachedJobs: DEFAULT_MAX_DETACHED_JOBS,
  activeJobCountCallbacks: [],
};

const defaultJobCancelRegistry = createJobCancelRegistry();

export function acquireJobPermit(record: CarrierJobRecord): JobPermit {
  const state = getGuardState();
  if (state.activeJobs.size >= state.maxDetachedJobs) {
    return { accepted: false, error: "concurrency limit" };
  }
  state.activeJobs.set(record.jobId, record);
  for (const carrierId of record.carriers) {
    const activeSet = state.activeCarrierJobs.get(carrierId) ?? new Set<string>();
    activeSet.add(record.jobId);
    state.activeCarrierJobs.set(carrierId, activeSet);
  }
  notifyActiveJobCountChange(state);
  return {
    accepted: true,
    release: (finished = {}) => releaseJobPermit(record.jobId, finished),
  };
}

export function releaseJobPermit(
  jobId: string,
  finished: Partial<Pick<CarrierJobRecord, "status" | "error" | "finishedAt">> = {},
): void {
  const state = getGuardState();
  const record = state.activeJobs.get(jobId);
  if (!record) return;
  for (const carrierId of record.carriers) {
    const activeSet = state.activeCarrierJobs.get(carrierId);
    if (!activeSet) continue;
    activeSet.delete(jobId);
    if (activeSet.size === 0) {
      state.activeCarrierJobs.delete(carrierId);
    }
  }
  record.status = finished.status ?? record.status;
  record.error = finished.error ?? record.error;
  record.finishedAt = finished.finishedAt ?? Date.now();
  state.activeJobs.delete(jobId);
  notifyActiveJobCountChange(state);
}

export function getActiveJob(jobId: string): CarrierJobRecord | null {
  return getGuardState().activeJobs.get(jobId) ?? null;
}

export function listActiveJobs(): CarrierJobRecord[] {
  return [...getGuardState().activeJobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getActiveBackgroundJobCount(): number {
  return getGuardState().activeJobs.size;
}

export function onActiveJobCountChange(callback: (count: number) => void): () => void {
  const state = getGuardState();
  state.activeJobCountCallbacks.push(callback);
  return () => {
    const index = state.activeJobCountCallbacks.indexOf(callback);
    if (index >= 0) state.activeJobCountCallbacks.splice(index, 1);
  };
}

export function configureDetachedJobCap(maxDetachedJobs: number): void {
  getGuardState().maxDetachedJobs = maxDetachedJobs;
}

export function resetJobConcurrencyForTest(): void {
  const state = getGuardState();
  state.activeJobs.clear();
  state.activeCarrierJobs.clear();
  state.maxDetachedJobs = DEFAULT_MAX_DETACHED_JOBS;
  state.activeJobCountCallbacks = [];
}

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

/**
 * 여러 AbortSignal을 하나로 결합합니다.
 * Node 20+에서는 내장 AbortSignal.any()를 사용하고,
 * Node 18에서는 AbortController 기반 폴리필로 동일 의미를 제공합니다.
 */

export function combineAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  if (signals.length === 0) {
    return new AbortController().signal;
  }

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([...signals]);
  }

  const abortedSignal = signals.find((signal) => signal.aborted);
  if (abortedSignal) {
    return AbortSignal.abort(abortedSignal.reason);
  }

  const controller = new AbortController();
  const cleanup = new Map<AbortSignal, () => void>();

  const abortFrom = (signal: AbortSignal) => {
    for (const [registeredSignal, listener] of cleanup) {
      registeredSignal.removeEventListener("abort", listener);
    }
    cleanup.clear();
    controller.abort(signal.reason);
  };

  for (const signal of signals) {
    const listener = () => {
      abortFrom(signal);
    };
    cleanup.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }

  return controller.signal;
}

export function launchResponseResult(response: CarrierJobLaunchResponse): { content: { type: "text"; text: string }[]; isError: boolean; details: CarrierJobLaunchResponse } {
  return {
    content: [{ type: "text", text: formatLaunchResponseText(response, response.accepted) }],
    isError: !response.accepted,
    details: response,
  };
}

export function startDetachedJob(options: StartDetachedJobOptions): DetachedJobLaunch {
  const jobId = buildCarrierJobId(options.jobKind, options.toolCallId ?? "");
  const permit = acquireJobPermit({
    jobId,
    tool: options.toolName,
    status: "active",
    startedAt: options.startedAt,
    carriers: options.carrierIds,
  });
  if (!permit.accepted) {
    const response = launchResponseResult({ job_id: jobId, accepted: false, error: permit.error });
    return { accepted: false, response };
  }

  createJobArchive(jobId, options.startedAt);
  const jobController = new AbortController();
  registerJobAbortController(jobId, jobController);
  const signal = options.signal
    ? combineAbortSignals([options.signal, jobController.signal])
    : jobController.signal;
  return { accepted: true, jobId, permit, signal };
}

export function finalizeDetachedJob(options: FinalizeDetachedJobOptions): void {
  putJobSummary(options.summary, options.finishedAt);
  finalizeJobArchive(options.jobId, options.status, options.finishedAt);
  unregisterJobAbortControllers(options.jobId);
  options.permit.release({ status: options.status, error: options.error, finishedAt: options.finishedAt });
}

/** Undo a launch that failed before it was accepted by the caller. */
export async function rollbackRejectedDetachedJob(options: RollbackRejectedDetachedJobOptions): Promise<void> {
  try {
    await options.abort?.();
  } finally {
    unregisterJobAbortControllers(options.jobId);
    detachJobArchive(options.jobId);
    options.permit.release();
  }
}

function notifyActiveJobCountChange(state: GuardState): void {
  const count = state.activeJobs.size;
  for (const callback of state.activeJobCountCallbacks) {
    try { callback(count); } catch { /* ignore listener failures */ }
  }
}

function getGuardState(): GuardState {
  return guardState;
}
