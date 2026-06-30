import { useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import { applyEvent, createEmptyJob, reduceSnapshotJob } from "./reduce.js";
import type { AgentClientState, AgentCliMetadata, JobView, ObservedEvent, ObservedTenant, ObserverTruncation, SessionInfo, SnapshotTenantJobs, TenantJobsView, TurnState } from "./types.js";

type Listener = () => void;

const EMPTY_TRUNCATION: ObserverTruncation = { droppedCount: 0 };

const listeners = new Set<Listener>();

let state: AgentClientState = {
  connection: "connecting",
  connectionError: null,
  agentClis: [],
  sessions: {},
  sessionOrder: [],
  tenants: [],
  tenantJobs: {},
  tenantOrder: [],
  activeTerminalSessionId: null,
  turnState: {},
};

export function useAgentState(): AgentClientState {
  return useStoreSnapshot(subscribe, getAgentState);
}

export function getAgentState(): AgentClientState {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setAgentState(patch: Partial<AgentClientState>): void {
  state = { ...state, ...patch };
  emit();
}

export function hydrateAgentClis(agentClis: readonly AgentCliMetadata[]): void {
  setAgentState({ agentClis });
}

export function hydrateSessions(sessions: readonly SessionInfo[]): void {
  const byId: Record<string, SessionInfo> = {};
  for (const session of sessions) byId[session.sessionId] = session;
  setAgentState({
    sessions: byId,
    sessionOrder: [...sessions].sort((a, b) => b.createdAt - a.createdAt).map((session) => session.sessionId),
  });
}

export function applySessionUpdate(session: SessionInfo): void {
  const known = Boolean(state.sessions[session.sessionId]);
  setAgentState({
    sessions: { ...state.sessions, [session.sessionId]: session },
    sessionOrder: known ? state.sessionOrder : [session.sessionId, ...state.sessionOrder],
    turnState: { ...state.turnState, [session.sessionId]: session.turnState },
  });
}

export function removeSession(sessionId: string): void {
  const { [sessionId]: _removed, ...sessions } = state.sessions;
  const { [sessionId]: _turnRemoved, ...turnState } = state.turnState;
  setAgentState({
    sessions,
    sessionOrder: state.sessionOrder.filter((id) => id !== sessionId),
    activeTerminalSessionId: state.activeTerminalSessionId === sessionId ? null : state.activeTerminalSessionId,
    turnState,
  });
}

export function selectSession(sessionId: string | null): void {
  setAgentState({ activeTerminalSessionId: sessionId });
}

export function applyTenantSnapshot(tenants: readonly ObservedTenant[]): void {
  setAgentState({
    tenants,
    tenantOrder: [
      ...tenants.map((tenant) => tenant.tenantId),
      ...state.tenantOrder.filter((tenantId) => !tenants.some((tenant) => tenant.tenantId === tenantId) && state.tenantJobs[tenantId]),
    ],
  });
}

export function applyJobsSnapshot(tenants: readonly SnapshotTenantJobs[]): void {
  const tenantJobs: Record<string, TenantJobsView> = {};
  for (const tenant of tenants) {
    const jobs: Record<string, JobView> = {};
    for (const snapshot of tenant.jobs) jobs[snapshot.jobId] = reduceSnapshotJob(tenant.tenantId, snapshot);
    tenantJobs[tenant.tenantId] = {
      tenantId: tenant.tenantId,
      tenantLabel: tenant.tenantLabel,
      jobOrder: tenant.jobs.map((job) => job.jobId),
      jobs,
      truncation: tenant.truncation ?? EMPTY_TRUNCATION,
    };
  }
  setAgentState({
    tenantJobs,
    tenantOrder: [
      ...tenants.map((tenant) => tenant.tenantId),
      ...state.tenantOrder.filter((tenantId) => tenantJobs[tenantId]),
    ],
  });
}

export function applyObservedEvent(event: ObservedEvent, tenantLabel?: string): { readonly job: JobView; readonly unknownTenant: boolean } {
  const tenantId = event.tenantId;
  const jobId = event.jobId ?? readJobId(event);
  const existing = state.tenantJobs[tenantId] ?? { tenantId, tenantLabel, jobOrder: [], jobs: {}, truncation: EMPTY_TRUNCATION };
  const previous = jobId ? existing.jobs[jobId] ?? createEmptyJob(tenantId, jobId, event.at) : createEmptyJob(tenantId, "__unknown__", event.at);
  const job = applyEvent(previous, event);
  const jobOrder = jobId && existing.jobOrder.includes(jobId) ? existing.jobOrder : jobId ? [jobId, ...existing.jobOrder] : existing.jobOrder;
  const tenant = { ...existing, tenantLabel: tenantLabel ?? existing.tenantLabel, jobOrder, jobs: jobId ? { ...existing.jobs, [jobId]: job } : existing.jobs };
  setAgentState({
    tenantJobs: { ...state.tenantJobs, [tenantId]: tenant },
    tenantOrder: state.tenantOrder.includes(tenantId) ? state.tenantOrder : [tenantId, ...state.tenantOrder],
  });
  return { job, unknownTenant: !state.tenantJobs[tenantId] };
}

export function applyTruncation(tenantId: string, tenantLabel: string | undefined, truncation: ObserverTruncation): void {
  const existing = state.tenantJobs[tenantId] ?? { tenantId, tenantLabel, jobOrder: [], jobs: {}, truncation: EMPTY_TRUNCATION };
  setAgentState({ tenantJobs: { ...state.tenantJobs, [tenantId]: { ...existing, tenantLabel: tenantLabel ?? existing.tenantLabel, truncation } } });
}

export function sessionJobs(session: SessionInfo): readonly JobView[] {
  const tenantId = session.tenantId;
  if (!tenantId) return [];
  const tenant = state.tenantJobs[tenantId];
  if (!tenant) return [];
  return tenant.jobOrder.map((jobId) => tenant.jobs[jobId]).filter((job): job is JobView => Boolean(job));
}

export function sessionTurnState(sessionId: string): TurnState {
  return state.turnState[sessionId] ?? state.sessions[sessionId]?.turnState ?? "none";
}

function emit(): void {
  for (const listener of listeners) listener();
}

function readJobId(event: ObservedEvent): string | null {
  const payload = event.event;
  return typeof payload.jobId === "string" ? payload.jobId : null;
}
