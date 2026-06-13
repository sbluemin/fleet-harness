import { applyEvent, createEmptyJob, isTerminalJobStatus, reduceSnapshotJob } from "./reduce.js";
import type {
  ConsoleState,
  JobView,
  ObservedEvent,
  ObservedTenant,
  ObserverTruncation,
  SessionInfo,
  SnapshotTenantJobs,
  TenantJobsView,
} from "./types.js";

type Listener = () => void;

export interface ActiveSessionJob {
  readonly job: JobView;
  readonly tenant: TenantJobsView;
}

const TENANT_JOB_LIMIT = 200;

const listeners = new Set<Listener>();
let state: ConsoleState = {
  connection: "connecting",
  connectionError: null,
  tenants: [],
  sessions: {},
  sessionOrder: [],
  activeTerminalSessionId: null,
  creatingTerminalSession: false,
  terminalSessionError: null,
  tenantJobs: {},
  tenantOrder: [],
  timelineOpen: false,
  coverOpen: false,
  coverDepth: "list",
  coverSelectedJobId: null,
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

export function hydrateTerminalSessions(sessions: readonly SessionInfo[]): void {
  const byId: Record<string, SessionInfo> = {};
  for (const session of sessions) byId[session.sessionId] = normalizeSession(session);
  const sessionOrder = [...sessions].sort((a, b) => b.createdAt - a.createdAt).map((session) => session.sessionId);
  setState({
    sessions: mergeTenantBindings(byId, state.tenants),
    sessionOrder,
    activeTerminalSessionId: state.activeTerminalSessionId && byId[state.activeTerminalSessionId] ? state.activeTerminalSessionId : state.activeTerminalSessionId,
  });
}

export function selectTerminalSession(sessionId: string | null): void {
  setState({ activeTerminalSessionId: sessionId });
}

export function beginCreateTerminalSession(): void {
  setState({ creatingTerminalSession: true, terminalSessionError: null });
}

export function completeCreateTerminalSession(session: SessionInfo): void {
  const normalized = normalizeSession(session);
  setState({
    sessions: { ...state.sessions, [normalized.sessionId]: normalized },
    sessionOrder: [normalized.sessionId, ...state.sessionOrder.filter((sessionId) => sessionId !== normalized.sessionId)],
    activeTerminalSessionId: normalized.sessionId,
    creatingTerminalSession: false,
    terminalSessionError: null,
  });
}

export function failCreateTerminalSession(error: string): void {
  setState({ creatingTerminalSession: false, terminalSessionError: error });
}

export function toggleTimeline(): void {
  setState({ timelineOpen: !state.timelineOpen });
}

export function toggleCover(): void {
  setState({
    coverOpen: !state.coverOpen,
    coverDepth: state.coverOpen ? state.coverDepth : "list",
    coverSelectedJobId: state.coverOpen ? state.coverSelectedJobId : null,
  });
}

export function selectCoverJob(jobId: string): void {
  setState({ coverOpen: true, coverDepth: "detail", coverSelectedJobId: jobId });
}

export function backToCoverList(): void {
  setState({ coverDepth: "list", coverSelectedJobId: null });
}

export function applyTenantSnapshot(tenants: readonly ObservedTenant[]): void {
  const known = new Set(tenants.map((tenant) => tenant.tenantId));
  const sessions = mergeTenantBindings(state.sessions, tenants);
  const tenantOrder = [
    ...tenants.map((tenant) => tenant.tenantId),
    ...state.tenantOrder.filter((tenantId) => !known.has(tenantId) && state.tenantJobs[tenantId]),
  ];
  setState({
    tenants,
    sessions,
    tenantOrder,
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
  const nextTenantJobs = { ...state.tenantJobs, [event.tenantId]: nextTenant };
  state = {
    ...state,
    connection: "live",
    connectionError: null,
    tenantJobs: nextTenantJobs,
    tenantOrder: state.tenantOrder.includes(event.tenantId) ? state.tenantOrder : [...state.tenantOrder, event.tenantId],
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

export function selectedCoverJob(current: ConsoleState): JobView | null {
  if (!current.coverSelectedJobId) return null;
  const tenantId = activeSessionTenantId(current);
  if (!tenantId) return null;
  return current.tenantJobs[tenantId]?.jobs[current.coverSelectedJobId] ?? null;
}

export function activeSessionTenantId(current: ConsoleState): string | null {
  if (!current.activeTerminalSessionId) return null;
  return resolveSessionTenantId(current.sessions[current.activeTerminalSessionId]);
}

export function activeSessionActiveJobs(current: ConsoleState): readonly ActiveSessionJob[] {
  const tenantId = activeSessionTenantId(current);
  if (!tenantId) return [];
  return activeJobsForTenant(current.tenantJobs[tenantId]);
}

export function sessionActiveJobs(current: ConsoleState, session: SessionInfo): readonly ActiveSessionJob[] {
  const tenantId = resolveSessionTenantId(session);
  if (!tenantId) return [];
  return activeJobsForTenant(current.tenantJobs[tenantId]);
}

export function resolveSessionTenantId(session: SessionInfo | undefined): string | null {
  return session?.tenantId ?? session?.sessionId ?? null;
}

function activeJobsForTenant(tenant: TenantJobsView | undefined): readonly ActiveSessionJob[] {
  if (!tenant) return [];
  const jobs: ActiveSessionJob[] = [];
  for (const jobId of tenant.jobOrder) {
    const job = tenant.jobs[jobId];
    if (job && !isTerminalJobStatus(job.status)) jobs.push({ job, tenant });
  }
  return jobs;
}

export function collectSessionTenantIds(sessions: Readonly<Record<string, SessionInfo>>, sessionOrder: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const sessionId of sessionOrder) {
    const tenantId = resolveSessionTenantId(sessions[sessionId]);
    if (tenantId) ids.add(tenantId);
  }
  return ids;
}

function normalizeSession(session: SessionInfo): SessionInfo {
  return {
    ...session,
    terminalSessionId: session.terminalSessionId ?? session.sessionId,
    status: session.status === "starting" && session.tenantId ? "registered" : session.status,
  };
}

function mergeTenantBindings(sessions: Readonly<Record<string, SessionInfo>>, tenants: readonly ObservedTenant[]): Record<string, SessionInfo> {
  const next = { ...sessions };
  for (const tenant of tenants) {
    if (!tenant.terminalSessionId) continue;
    const session = next[tenant.terminalSessionId];
    if (!session) continue;
    next[tenant.terminalSessionId] = {
      ...session,
      status: tenant.status === "deregistered" ? "closed" : "registered",
      tenantId: tenant.tenantId,
      registrationId: tenant.registrationId,
    };
  }
  return next;
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
