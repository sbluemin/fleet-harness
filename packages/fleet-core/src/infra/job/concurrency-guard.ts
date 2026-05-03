import type { CarrierJobRecord } from "./job-types.js";

interface GuardState {
  activeJobs: Map<string, CarrierJobRecord>;
  activeCarrierJobs: Map<string, string>;
  maxDetachedJobs: number;
  activeJobCountCallbacks: Array<(count: number) => void>;
}

export interface JobPermitAccepted {
  accepted: true;
  release: (finished?: Partial<Pick<CarrierJobRecord, "status" | "error" | "finishedAt">>) => void;
}

export interface JobPermitRejected {
  accepted: false;
  error: "concurrency limit" | "carrier busy";
  current_job_id?: string;
}

export type JobPermit = JobPermitAccepted | JobPermitRejected;

const GUARD_STATE_KEY = "__pi_fleet_job_concurrency_guard__";
const DEFAULT_MAX_DETACHED_JOBS = 5;

export function acquireJobPermit(record: CarrierJobRecord): JobPermit {
  const state = getGuardState();
  for (const carrierId of record.carriers) {
    const current = state.activeCarrierJobs.get(carrierId);
    if (current) {
      return { accepted: false, error: "carrier busy", current_job_id: current };
    }
  }
  if (state.activeJobs.size >= state.maxDetachedJobs) {
    return { accepted: false, error: "concurrency limit" };
  }
  state.activeJobs.set(record.jobId, record);
  for (const carrierId of record.carriers) {
    state.activeCarrierJobs.set(carrierId, record.jobId);
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
    if (state.activeCarrierJobs.get(carrierId) === jobId) {
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
  const root = globalThis as Record<string, unknown>;
  const existing = root[GUARD_STATE_KEY] as GuardState | undefined;
  if (existing) return existing;
  const state: GuardState = {
    activeJobs: new Map(),
    activeCarrierJobs: new Map(),
    maxDetachedJobs: DEFAULT_MAX_DETACHED_JOBS,
    activeJobCountCallbacks: [],
  };
  root[GUARD_STATE_KEY] = state;
  return state;
}
