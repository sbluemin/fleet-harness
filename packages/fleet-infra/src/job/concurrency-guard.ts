import type { CarrierJobRecord } from "./job-types.js";

interface GuardState {
  activeJobs: Map<string, CarrierJobRecord>;
  activeCarrierJobs: Map<string, Set<string>>;
  maxDetachedJobs: number;
  activeJobCountCallbacks: Array<(count: number) => void>;
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

const DEFAULT_MAX_DETACHED_JOBS = 5;
const guardState: GuardState = {
  activeJobs: new Map(),
  activeCarrierJobs: new Map(),
  maxDetachedJobs: DEFAULT_MAX_DETACHED_JOBS,
  activeJobCountCallbacks: [],
};

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

function notifyActiveJobCountChange(state: GuardState): void {
  const count = state.activeJobs.size;
  for (const callback of state.activeJobCountCallbacks) {
    try { callback(count); } catch { /* ignore listener failures */ }
  }
}

function getGuardState(): GuardState {
  return guardState;
}
