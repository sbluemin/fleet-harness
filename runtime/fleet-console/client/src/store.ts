import { applyEvent, createEmptyJob, isTerminalJobStatus, reduceSnapshotJob } from "./reduce.js";
import type {
  ConsoleState,
  JobView,
  ObservedEvent,
  ObservedTenant,
  ObserverTruncation,
  SnapshotTenantJobs,
  TenantJobsView,
} from "./types.js";

type Listener = () => void;

const TENANT_JOB_LIMIT = 200;

const listeners = new Set<Listener>();
let state: ConsoleState = {
  token: null,
  terminalToken: null,
  connection: "auth-needed",
  connectionError: null,
  tenants: [],
  tenantJobs: {},
  tenantOrder: [],
  selectedTenantId: null,
  selectedJobId: null,
  timelineOpen: false,
  coverOpen: false,
};

export function getState(): ConsoleState {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setState(patch: Partial<ConsoleState>): void {
  state = { ...state, ...patch };
  emit();
}

export function resetForToken(token: string | null, terminalToken: string | null = state.terminalToken): void {
  state = {
    ...state,
    token,
    terminalToken,
    connection: token ? "connecting" : "auth-needed",
    connectionError: null,
  };
  emit();
}

export function selectTenant(tenantId: string): void {
  if (state.selectedTenantId === tenantId) return;
  const tenant = state.tenantJobs[tenantId];
  setState({ selectedTenantId: tenantId, selectedJobId: tenant?.jobOrder[0] ?? null });
}

export function selectJob(tenantId: string, jobId: string): void {
  setState({ selectedTenantId: tenantId, selectedJobId: jobId });
}

export function toggleTimeline(): void {
  setState({ timelineOpen: !state.timelineOpen });
}

export function toggleCover(): void {
  setState({ coverOpen: !state.coverOpen });
}

export function applyTenantSnapshot(tenants: readonly ObservedTenant[]): void {
  const known = new Set(tenants.map((tenant) => tenant.tenantId));
  const tenantOrder = [
    ...tenants.map((tenant) => tenant.tenantId),
    ...state.tenantOrder.filter((tenantId) => !known.has(tenantId) && state.tenantJobs[tenantId]),
  ];
  setState({
    tenants,
    tenantOrder,
    selectedTenantId: state.selectedTenantId ?? tenantOrder[0] ?? null,
  });
}

export function applyJobsSnapshot(snapshot: readonly SnapshotTenantJobs[]): void {
  const tenantJobs: Record<string, TenantJobsView> = {};
  const tenantOrder: string[] = [];
  for (const tenant of snapshot) {
    const jobs: Record<string, JobView> = {};
    const jobOrder: string[] = [];
    for (const job of [...tenant.jobs].sort((a, b) => b.updatedAt - a.updatedAt)) {
      jobs[job.jobId] = reduceSnapshotJob(tenant.tenantId, job);
      jobOrder.push(job.jobId);
    }
    tenantJobs[tenant.tenantId] = {
      tenantId: tenant.tenantId,
      tenantLabel: tenant.tenantLabel,
      jobOrder,
      jobs,
      truncation: tenant.truncation,
    };
    tenantOrder.push(tenant.tenantId);
  }
  const mergedOrder = [
    ...state.tenantOrder.filter((tenantId) => tenantJobs[tenantId]),
    ...tenantOrder.filter((tenantId) => !state.tenantOrder.includes(tenantId)),
  ];
  setState({
    tenantJobs,
    tenantOrder: mergedOrder.length > 0 ? mergedOrder : tenantOrder,
    selectedTenantId: pickSelectedTenant(tenantJobs),
    selectedJobId: pickSelectedJob(tenantJobs),
  });
}

export function applyObservedEvent(event: ObservedEvent, tenantLabel?: string): { readonly unknownTenant: boolean } {
  const existingTenant = state.tenantJobs[event.tenantId];
  const unknownTenant = !existingTenant && !state.tenants.some((tenant) => tenant.tenantId === event.tenantId);
  const tenant: TenantJobsView = existingTenant ?? {
    tenantId: event.tenantId,
    tenantLabel,
    jobOrder: [],
    jobs: {},
    truncation: { droppedCount: 0 },
  };
  let nextTenant = tenantLabel && tenant.tenantLabel !== tenantLabel ? { ...tenant, tenantLabel } : tenant;
  if (event.jobId) {
    const existingJob = nextTenant.jobs[event.jobId];
    const job = applyEvent(existingJob ?? createEmptyJob(event.tenantId, event.jobId, event.at), event);
    const jobOrder = sortJobOrder(
      existingJob ? nextTenant.jobOrder : [...nextTenant.jobOrder, event.jobId],
      { ...nextTenant.jobs, [event.jobId]: job },
    );
    nextTenant = {
      ...nextTenant,
      jobs: pruneJobs({ ...nextTenant.jobs, [event.jobId]: job }, jobOrder),
      jobOrder: jobOrder.slice(0, TENANT_JOB_LIMIT),
    };
  }
  // 자동 선택은 선택된 테넌트가 없거나 이벤트가 그 테넌트의 것일 때만 — 다른 테넌트의 라이브 이벤트가 선택을 선점하지 않는다.
  const nextSelectedTenantId = state.selectedTenantId ?? event.tenantId;
  const mayAutoSelectJob = state.selectedJobId === null && nextSelectedTenantId === event.tenantId;
  state = {
    ...state,
    connection: "live",
    connectionError: null,
    tenantJobs: { ...state.tenantJobs, [event.tenantId]: nextTenant },
    tenantOrder: state.tenantOrder.includes(event.tenantId) ? state.tenantOrder : [...state.tenantOrder, event.tenantId],
    selectedTenantId: nextSelectedTenantId,
    selectedJobId: mayAutoSelectJob ? event.jobId ?? null : state.selectedJobId,
  };
  emit();
  return { unknownTenant };
}

export function applyTruncation(tenantId: string, tenantLabel: string | undefined, truncation: ObserverTruncation): void {
  const existing = state.tenantJobs[tenantId] ?? {
    tenantId,
    tenantLabel,
    jobOrder: [],
    jobs: {},
    truncation: { droppedCount: 0 },
  };
  setState({
    tenantJobs: { ...state.tenantJobs, [tenantId]: { ...existing, truncation } },
    tenantOrder: state.tenantOrder.includes(tenantId) ? state.tenantOrder : [...state.tenantOrder, tenantId],
  });
}

export function selectedJob(current: ConsoleState): JobView | null {
  const tenantId = current.selectedTenantId;
  if (!tenantId) return null;
  const tenant = current.tenantJobs[tenantId];
  if (!tenant) return null;
  const jobId = current.selectedJobId && tenant.jobs[current.selectedJobId] ? current.selectedJobId : tenant.jobOrder[0];
  return jobId ? tenant.jobs[jobId] ?? null : null;
}

function pickSelectedTenant(tenantJobs: Record<string, TenantJobsView>): string | null {
  if (state.selectedTenantId && tenantJobs[state.selectedTenantId]) return state.selectedTenantId;
  if (state.selectedTenantId && state.tenants.some((tenant) => tenant.tenantId === state.selectedTenantId)) {
    return state.selectedTenantId;
  }
  return Object.keys(tenantJobs)[0] ?? state.tenants[0]?.tenantId ?? null;
}

function pickSelectedJob(tenantJobs: Record<string, TenantJobsView>): string | null {
  const tenantId = pickSelectedTenant(tenantJobs);
  if (!tenantId) return null;
  const tenant = tenantJobs[tenantId];
  if (!tenant) return null;
  if (state.selectedJobId && tenant.jobs[state.selectedJobId]) return state.selectedJobId;
  return tenant.jobOrder[0] ?? null;
}

function sortJobOrder(order: readonly string[], jobs: Readonly<Record<string, JobView>>): string[] {
  return [...order].sort((a, b) => {
    const jobA = jobs[a];
    const jobB = jobs[b];
    const activeA = jobA && !isTerminalJobStatus(jobA.status) ? 1 : 0;
    const activeB = jobB && !isTerminalJobStatus(jobB.status) ? 1 : 0;
    if (activeA !== activeB) return activeB - activeA;
    return (jobB?.updatedAt ?? 0) - (jobA?.updatedAt ?? 0);
  });
}

function pruneJobs(jobs: Record<string, JobView>, order: readonly string[]): Record<string, JobView> {
  if (order.length <= TENANT_JOB_LIMIT) return jobs;
  const keep = new Set(order.slice(0, TENANT_JOB_LIMIT));
  const pruned: Record<string, JobView> = {};
  for (const jobId of Object.keys(jobs)) {
    if (keep.has(jobId)) pruned[jobId] = jobs[jobId]!;
  }
  return pruned;
}

function emit(): void {
  for (const listener of listeners) listener();
}
