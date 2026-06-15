import { sessionDisplayLabel, statusTone } from "./format.js";
import { isTerminalJobStatus } from "./reduce.js";
import type { ConsoleState, JobView, ObservedTenant, SessionInfo, TheaterInfo } from "./types.js";

export interface BridgeView {
  readonly activeTheater: TheaterBrief | null;
  readonly readiness: OperationsReadiness;
  readonly theaters: readonly TheaterReadiness[];
  readonly connection: "connecting" | "live";
  readonly connectionError: string | null;
}

export interface TheaterBrief {
  readonly id: string;
  readonly label: string;
  readonly hasWiki: boolean;
  readonly activeAdmiralCount: number;
  readonly terminalSessionCount: number;
  readonly registeredTenantCount: number;
  readonly lastActivityAt: number | null;
}

export interface OperationsReadiness {
  readonly activeSessionLabel: string;
  readonly terminalSessionCount: number;
  readonly liveJobCount: number;
  readonly completedJobCount: number;
  readonly failedJobCount: number;
  readonly emptyState: "no-theaters" | "no-sessions" | "no-jobs" | null;
}

export interface TheaterReadiness {
  readonly id: string;
  readonly label: string;
  readonly hasWiki: boolean;
  readonly activeAdmiralCount: number;
  readonly terminalSessionCount: number;
  readonly liveJobCount: number;
  readonly lastActivityAt: number | null;
  readonly active: boolean;
}

export function buildBridgeView(state: ConsoleState): BridgeView {
  return {
    activeTheater: buildTheaterBrief(state),
    readiness: summarizeOperationsReadiness(state, state.activeTheaterId),
    theaters: collectTheaterReadiness(state),
    connection: state.connection,
    connectionError: state.connectionError,
  };
}

export function collectTheaterReadiness(state: ConsoleState): readonly TheaterReadiness[] {
  return state.theaters.map((theater) => {
    const sessions = sessionsForTheater(state, theater.id);
    const tenants = tenantsForTheater(state, theater.id);
    const jobs = jobsForTenants(state, tenants);
    return {
      id: theater.id,
      label: theater.label,
      hasWiki: theater.hasWiki,
      activeAdmiralCount: theater.activeAdmiralCount,
      terminalSessionCount: sessions.length,
      liveJobCount: jobs.filter((job) => statusTone(job.status) === "live").length,
      lastActivityAt: latestTimestamp([
        Date.parse(theater.lastOpenedAt),
        ...sessions.map((session) => session.createdAt),
        ...tenants.map((tenant) => tenant.createdAt),
        ...jobs.map((job) => job.updatedAt),
      ]),
      active: theater.id === state.activeTheaterId,
    };
  });
}

export function summarizeOperationsReadiness(state: ConsoleState, theaterId: string | null): OperationsReadiness {
  const sessions = theaterId ? sessionsForTheater(state, theaterId) : [];
  const tenants = theaterId ? tenantsForTheater(state, theaterId) : [];
  const jobs = jobsForTenants(state, tenants);
  const liveJobCount = jobs.filter((job) => statusTone(job.status) === "live").length;
  const completedJobCount = jobs.filter((job) => isTerminalJobStatus(job.status) && job.status === "done").length;
  const failedJobCount = jobs.filter((job) => isTerminalJobStatus(job.status) && (job.status === "error" || job.status === "aborted")).length;
  const activeSession = state.activeTerminalSessionId ? state.sessions[state.activeTerminalSessionId] : undefined;
  return {
    activeSessionLabel: activeSession && theaterId && activeSession.theaterId === theaterId ? sessionDisplayLabel(activeSession) : "No active session",
    terminalSessionCount: sessions.length,
    liveJobCount,
    completedJobCount,
    failedJobCount,
    emptyState: resolveEmptyState(state, sessions, jobs),
  };
}

function buildTheaterBrief(state: ConsoleState): TheaterBrief | null {
  const theater = state.theaters.find((item) => item.id === state.activeTheaterId);
  if (!theater) return null;
  const sessions = sessionsForTheater(state, theater.id);
  const tenants = tenantsForTheater(state, theater.id);
  const jobs = jobsForTenants(state, tenants);
  return {
    id: theater.id,
    label: theater.label,
    hasWiki: theater.hasWiki,
    activeAdmiralCount: theater.activeAdmiralCount,
    terminalSessionCount: sessions.length,
    registeredTenantCount: tenants.filter((tenant) => tenant.status !== "closed").length,
    lastActivityAt: latestTimestamp([
      Date.parse(theater.lastOpenedAt),
      ...sessions.map((session) => session.createdAt),
      ...tenants.map((tenant) => tenant.createdAt),
      ...jobs.map((job) => job.updatedAt),
    ]),
  };
}

function sessionsForTheater(state: ConsoleState, theaterId: string): readonly SessionInfo[] {
  return state.sessionOrder
    .map((sessionId) => state.sessions[sessionId])
    .filter((session): session is SessionInfo => session !== undefined && session.theaterId === theaterId);
}

function tenantsForTheater(state: ConsoleState, theaterId: string): readonly ObservedTenant[] {
  return state.tenants.filter((tenant) => tenant.theaterId === theaterId);
}

function jobsForTenants(state: ConsoleState, tenants: readonly ObservedTenant[]): readonly JobView[] {
  const jobs: JobView[] = [];
  for (const tenant of tenants) {
    const tenantJobs = state.tenantJobs[tenant.tenantId];
    if (!tenantJobs) continue;
    for (const jobId of tenantJobs.jobOrder) {
      const job = tenantJobs.jobs[jobId];
      if (job) jobs.push(job);
    }
  }
  return jobs;
}

function resolveEmptyState(state: ConsoleState, sessions: readonly SessionInfo[], jobs: readonly JobView[]): OperationsReadiness["emptyState"] {
  if (state.theaters.length === 0) return "no-theaters";
  if (sessions.length === 0) return "no-sessions";
  if (jobs.length === 0) return "no-jobs";
  return null;
}

function latestTimestamp(values: readonly number[]): number | null {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return null;
  return Math.max(...valid);
}
