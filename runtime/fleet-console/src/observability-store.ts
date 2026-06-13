import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  CliSession,
  PushEventEnvelope,
  RegisterCliRequest,
  RegisterCliResponse,
} from "@dotobokuri/core-agent";

import type {
  ConsoleObservedEvent,
  ConsoleObservedJob,
  ConsoleObservedWorkspace,
  ConsoleObserverTruncation,
  ConsoleTerminalSessionInfo,
  ConsoleTerminalSessionStatus,
} from "./api-types.js";

export interface ConsoleObservabilityStoreDeps {
  readonly now?: () => number;
  readonly nowIso?: () => string;
  readonly randomToken?: () => string;
  readonly heartbeatIntervalMs?: number;
  readonly leaseTtlMs?: number;
  readonly maxBatchEvents?: number;
}

export interface PushEventsResult {
  readonly accepted: number;
  readonly highestContiguousSeq: number;
}

interface WorkspaceState {
  session: CliSession;
  readonly ingestToken: string;
  readonly terminalSessionId?: string;
  highestSeq: number;
  readonly seenSeqs: Set<number>;
}

interface PendingTerminalSessionState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly canonicalCwd: string;
  readonly cwdLabel: string;
  readonly createdAt: number;
  readonly terminalSessionId: string;
  status: ConsoleTerminalSessionStatus;
  registrationId?: string;
  cliRunId?: string;
}

interface TenantJobState {
  readonly jobs: Map<string, ConsoleObservedJob>;
  readonly finalizedOrder: string[];
}

type ConsoleObservedEventListener = (event: ConsoleObservedEvent) => void;

const TENANT_EVENT_LIMIT = 1_000;
const JOB_EVENT_LIMIT = 200;
const TENANT_FINALIZED_JOB_LIMIT = 100;
const TENANT_JOB_LIMIT = 200;
const EVENT_TEXT_RETENTION_LIMIT = 8_192;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_TTL_MS = 20_000;
const DEFAULT_MAX_BATCH_EVENTS = 200;

export function createConsoleObservabilityStore(deps: ConsoleObservabilityStoreDeps = {}) {
  const now = deps.now ?? Date.now;
  const nowIso = deps.nowIso ?? (() => new Date(now()).toISOString());
  const randomToken = deps.randomToken ?? (() => crypto.randomBytes(32).toString("base64url"));
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const maxBatchEvents = deps.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS;
  const workspacesByCliRunId = new Map<string, WorkspaceState>();
  const workspacesByRegistrationId = new Map<string, WorkspaceState>();
  const workspacesByIngestToken = new Map<string, WorkspaceState>();
  const eventsByTenant = new Map<string, ConsoleObservedEvent[]>();
  const truncationByTenant = new Map<string, ConsoleObserverTruncation>();
  const jobsByTenant = new Map<string, TenantJobState>();
  const terminalSessionsById = new Map<string, PendingTerminalSessionState>();
  const listenersByTenant = new Map<string, Set<ConsoleObservedEventListener>>();
  const allListeners = new Set<ConsoleObservedEventListener>();
  let nextObservedId = 1;

  function register(input: RegisterCliRequest): RegisterCliResponse {
    assertRegisterInput(input);
    const previous = workspacesByCliRunId.get(input.cliRunId);
    if (previous) removeWorkspaceIndexes(previous);
    const terminalSession = bindPendingTerminalSession(input);

    const registeredAt = nowIso();
    const registrationId = crypto.randomUUID();
    const ingestToken = randomToken();
    const session: CliSession = {
      registrationId,
      cliRunId: input.cliRunId,
      tenantLabel: input.tenantLabel,
      cwd: input.cwd,
      pid: input.pid,
      startedAt: input.startedAt,
      fleetVersion: input.fleetVersion,
      registeredAt,
      lastHeartbeatAt: registeredAt,
      leaseExpiresAt: new Date(Date.parse(registeredAt) + leaseTtlMs).toISOString(),
      status: "online",
      mcp: input.mcp,
    };
    const state: WorkspaceState = {
      session,
      ingestToken,
      terminalSessionId: terminalSession?.terminalSessionId,
      highestSeq: 0,
      seenSeqs: new Set(),
    };
    if (terminalSession) {
      terminalSession.status = "registered";
      terminalSession.registrationId = registrationId;
      terminalSession.cliRunId = input.cliRunId;
    }
    workspacesByCliRunId.set(session.cliRunId, state);
    workspacesByRegistrationId.set(session.registrationId, state);
    workspacesByIngestToken.set(ingestToken, state);
    return {
      registrationId,
      ingestToken,
      heartbeatIntervalMs,
      leaseTtlMs,
      maxBatchEvents,
    };
  }

  function pushEvents(token: string, events: readonly PushEventEnvelope[]): PushEventsResult | null {
    markExpiredSessions();
    const workspace = workspacesByIngestToken.get(token);
    if (!workspace || workspace.session.status === "deregistered") return null;
    let accepted = 0;
    for (const envelope of events.slice(0, maxBatchEvents)) {
      if (envelope.cliRunId !== workspace.session.cliRunId) continue;
      if (!Number.isSafeInteger(envelope.seq) || envelope.seq <= 0) continue;
      if (workspace.seenSeqs.has(envelope.seq) || envelope.seq <= workspace.highestSeq) continue;
      if (envelope.seq > workspace.highestSeq + 1) {
        appendSyntheticTruncation(workspace, workspace.highestSeq + 1, envelope.seq - 1);
      }
      append(workspace.session.cliRunId, envelope.event, parseTime(envelope.at));
      workspace.seenSeqs.add(envelope.seq);
      workspace.highestSeq = envelope.seq;
      accepted += 1;
    }
    return { accepted, highestContiguousSeq: workspace.highestSeq };
  }

  function heartbeat(token: string, cliRunId: string, registrationId: string): { readonly accepted: boolean; readonly leaseExpiresAt: string } | null {
    const workspace = workspacesByIngestToken.get(token);
    if (!workspace || workspace.session.cliRunId !== cliRunId || workspace.session.registrationId !== registrationId || workspace.session.status === "deregistered") {
      return null;
    }
    const heartbeatAt = nowIso();
    const leaseExpiresAt = new Date(Date.parse(heartbeatAt) + leaseTtlMs).toISOString();
    workspace.session = {
      ...workspace.session,
      status: "online",
      lastHeartbeatAt: heartbeatAt,
      leaseExpiresAt,
    };
    return { accepted: true, leaseExpiresAt };
  }

  function deregister(token: string, cliRunId: string, registrationId: string): boolean {
    const workspace = workspacesByIngestToken.get(token);
    if (!workspace || workspace.session.cliRunId !== cliRunId || workspace.session.registrationId !== registrationId) {
      return false;
    }
    workspace.session = { ...workspace.session, status: "deregistered" };
    return true;
  }

  function append(tenantId: string, rawEvent: unknown, at = now()): ConsoleObservedEvent {
    const eventObject = typeof rawEvent === "object" && rawEvent !== null ? rawEvent as Record<string, unknown> : {};
    const event: ConsoleObservedEvent = {
      id: nextObservedId,
      tenantId,
      jobId: typeof eventObject.jobId === "string" ? eventObject.jobId : undefined,
      type: typeof eventObject.type === "string" ? eventObject.type : "event",
      at,
      event: normalizeEventPayload(rawEvent),
    };
    nextObservedId += 1;
    storeObservedEvent(event);
    return event;
  }

  function listWorkspaces(): readonly ConsoleObservedWorkspace[] {
    markExpiredSessions();
    return Array.from(workspacesByCliRunId.values())
      .map((workspace) => ({
        tenantId: workspace.session.cliRunId,
        tenantLabel: workspace.session.tenantLabel,
        cwd: workspace.session.cwd,
        createdAt: Date.parse(workspace.session.registeredAt),
        sessions: workspace.session.status === "deregistered" ? 0 : 1,
        status: workspace.session.status,
        cliRunId: workspace.session.cliRunId,
        registrationId: workspace.session.registrationId,
        terminalSessionId: workspace.terminalSessionId,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function getWorkspace(tenantId: string): ConsoleObservedWorkspace | null {
    return listWorkspaces().find((workspace) => workspace.tenantId === tenantId) ?? null;
  }

  function listEvents(tenantId: string): readonly ConsoleObservedEvent[] {
    return eventsByTenant.get(tenantId) ?? [];
  }

  function listJobs(tenantId: string): readonly ConsoleObservedJob[] {
    return Array.from(getTenantJobState(tenantId).jobs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function getTruncation(tenantId: string): ConsoleObserverTruncation {
    return truncationByTenant.get(tenantId) ?? { droppedCount: 0 };
  }

  function subscribe(tenantId: string, listener: ConsoleObservedEventListener): () => void {
    const listeners = listenersByTenant.get(tenantId) ?? new Set();
    listeners.add(listener);
    listenersByTenant.set(tenantId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) listenersByTenant.delete(tenantId);
    };
  }

  function subscribeAll(listener: ConsoleObservedEventListener): () => void {
    allListeners.add(listener);
    return () => {
      allListeners.delete(listener);
    };
  }

  function markExpiredSessions(): void {
    const current = now();
    for (const workspace of workspacesByCliRunId.values()) {
      if (workspace.session.status !== "online") continue;
      if (Date.parse(workspace.session.leaseExpiresAt) <= current) {
        workspace.session = { ...workspace.session, status: "offline" };
      }
    }
  }

  function getLaunchCwd(registrationId?: string | null, cliRunId?: string | null): string {
    markExpiredSessions();
    const workspace = registrationId
      ? workspacesByRegistrationId.get(registrationId)
      : cliRunId
        ? workspacesByCliRunId.get(cliRunId)
        : Array.from(workspacesByCliRunId.values()).find((candidate) => candidate.session.status === "online")
          ?? Array.from(workspacesByCliRunId.values())[0];
    return workspace?.session.cwd ?? process.cwd();
  }

  function createPendingTerminalSession(input: { readonly sessionId: string; readonly cwd: string; readonly createdAt?: number }): ConsoleTerminalSessionInfo {
    if (!path.isAbsolute(input.cwd)) throw new Error("Terminal session cwd must be absolute");
    const createdAt = input.createdAt ?? now();
    const state: PendingTerminalSessionState = {
      sessionId: input.sessionId,
      cwd: input.cwd,
      canonicalCwd: canonicalizeCwd(input.cwd),
      cwdLabel: path.basename(input.cwd) || input.cwd,
      createdAt,
      terminalSessionId: input.sessionId,
      status: "starting",
    };
    terminalSessionsById.set(state.sessionId, state);
    return toTerminalSessionInfo(state);
  }

  function listTerminalSessions(): readonly ConsoleTerminalSessionInfo[] {
    return Array.from(terminalSessionsById.values()).map(toTerminalSessionInfo).sort((a, b) => b.createdAt - a.createdAt);
  }

  function updateTerminalSessionStatus(sessionId: string, status: ConsoleTerminalSessionStatus): ConsoleTerminalSessionInfo | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    session.status = status;
    return toTerminalSessionInfo(session);
  }

  function removeTerminalSession(sessionId: string): boolean {
    return terminalSessionsById.delete(sessionId);
  }

  function clear(): void {
    workspacesByCliRunId.clear();
    workspacesByRegistrationId.clear();
    workspacesByIngestToken.clear();
    eventsByTenant.clear();
    truncationByTenant.clear();
    jobsByTenant.clear();
    terminalSessionsById.clear();
    listenersByTenant.clear();
    allListeners.clear();
  }

  return {
    append,
    clear,
    deregister,
    getLaunchCwd,
    getTruncation,
    getWorkspace,
    heartbeat,
    listEvents,
    listJobs,
    listTerminalSessions,
    listWorkspaces,
    markExpiredSessions,
    pushEvents,
    register,
    createPendingTerminalSession,
    subscribe,
    subscribeAll,
    updateTerminalSessionStatus,
    removeTerminalSession,
    workspaceCount: () => listWorkspaces().filter((workspace) => workspace.status !== "deregistered").length,
  };

  function appendSyntheticTruncation(workspace: WorkspaceState, fromSeq: number, toSeq: number): void {
    append(workspace.session.cliRunId, {
      type: "observer:truncated",
      missingFromSeq: fromSeq,
      missingToSeq: toSeq,
      droppedCount: toSeq - fromSeq + 1,
    });
  }

  function bindPendingTerminalSession(input: RegisterCliRequest): PendingTerminalSessionState | null {
    const pending = terminalSessionsById.get(input.cliRunId);
    if (!pending) return null;
    if (pending.canonicalCwd !== canonicalizeCwd(input.cwd)) {
      throw new Error("Terminal session registration cwd mismatch");
    }
    return pending;
  }

  function storeObservedEvent(event: ConsoleObservedEvent): void {
    const list = eventsByTenant.get(event.tenantId) ?? [];
    list.push(event);
    if (list.length > TENANT_EVENT_LIMIT) {
      const dropped = list.length - TENANT_EVENT_LIMIT;
      const retained = list.slice(dropped);
      eventsByTenant.set(event.tenantId, retained);
      const previous = truncationByTenant.get(event.tenantId);
      truncationByTenant.set(event.tenantId, {
        droppedCount: (previous?.droppedCount ?? 0) + dropped,
        droppedBeforeId: retained[0]?.id,
      });
    } else {
      eventsByTenant.set(event.tenantId, list);
      if (!truncationByTenant.has(event.tenantId)) truncationByTenant.set(event.tenantId, { droppedCount: 0 });
    }
    updateJobSnapshot(event.tenantId, event);
    for (const listener of listenersByTenant.get(event.tenantId) ?? []) listener(event);
    for (const listener of allListeners) listener(event);
  }

  function getTenantJobState(tenantId: string): TenantJobState {
    const existing = jobsByTenant.get(tenantId);
    if (existing) return existing;
    const created = { jobs: new Map<string, ConsoleObservedJob>(), finalizedOrder: [] };
    jobsByTenant.set(tenantId, created);
    return created;
  }

  function updateJobSnapshot(tenantId: string, event: ConsoleObservedEvent): void {
    if (!event.jobId) return;
    const state = getTenantJobState(tenantId);
    const previous = state.jobs.get(event.jobId);
    const status = inferStatus(event.type, event.event, previous?.status);
    state.jobs.set(event.jobId, {
      jobId: event.jobId,
      status,
      updatedAt: event.at,
      events: [...(previous?.events ?? []), event].slice(-JOB_EVENT_LIMIT),
    });
    if (event.type === "job:finalized") {
      const existingIndex = state.finalizedOrder.indexOf(event.jobId);
      if (existingIndex >= 0) state.finalizedOrder.splice(existingIndex, 1);
      state.finalizedOrder.push(event.jobId);
      while (state.finalizedOrder.length > TENANT_FINALIZED_JOB_LIMIT) {
        const prunedJobId = state.finalizedOrder.shift();
        if (prunedJobId) state.jobs.delete(prunedJobId);
      }
    }
    pruneTenantJobs(state);
  }

  function removeWorkspaceIndexes(workspace: WorkspaceState): void {
    workspacesByRegistrationId.delete(workspace.session.registrationId);
    workspacesByIngestToken.delete(workspace.ingestToken);
  }
}

function canonicalizeCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function toTerminalSessionInfo(state: PendingTerminalSessionState): ConsoleTerminalSessionInfo {
  return {
    sessionId: state.sessionId,
    terminalSessionId: state.terminalSessionId,
    cwdLabel: state.cwdLabel,
    status: state.status,
    createdAt: state.createdAt,
    registrationId: state.registrationId,
    cliRunId: state.cliRunId,
    tenantId: state.cliRunId,
  };
}

function assertRegisterInput(input: RegisterCliRequest): void {
  if (!input.protocolVersion || !input.cliRunId || !input.tenantLabel || !input.cwd || !input.fleetVersion) {
    throw new Error("Invalid registration payload");
  }
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new Error("Invalid registration pid");
  }
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function pruneTenantJobs(state: TenantJobState): void {
  if (state.jobs.size <= TENANT_JOB_LIMIT) return;
  const byOldest = Array.from(state.jobs.values()).sort((a, b) => a.updatedAt - b.updatedAt);
  for (const job of byOldest) {
    if (state.jobs.size <= TENANT_JOB_LIMIT) break;
    state.jobs.delete(job.jobId);
    const finalizedIndex = state.finalizedOrder.indexOf(job.jobId);
    if (finalizedIndex >= 0) state.finalizedOrder.splice(finalizedIndex, 1);
  }
}

function inferStatus(type: string, event: Record<string, unknown>, previousStatus = "active"): string {
  if (type !== "job:finalized") return previousStatus === "done" || previousStatus === "error" || previousStatus === "aborted" ? previousStatus : "active";
  return typeof event.status === "string" ? event.status : "done";
}

function normalizeEventPayload(event: unknown): Record<string, unknown> {
  if (typeof event !== "object" || event === null) return {};
  const obj = event as Record<string, unknown>;
  if (obj.type === "track:text" || obj.type === "track:thought") {
    return {
      ...obj,
      text: clampText(obj.text),
      textLength: typeof obj.text === "string" ? obj.text.length : 0,
    };
  }
  if (obj.type === "track:finalized") {
    return {
      ...obj,
      fallbackText: clampText(obj.fallbackText),
      fallbackTextLength: typeof obj.fallbackText === "string" ? obj.fallbackText.length : undefined,
      fallbackThought: clampText(obj.fallbackThought),
      fallbackThoughtLength: typeof obj.fallbackThought === "string" ? obj.fallbackThought.length : undefined,
    };
  }
  return obj;
}

function clampText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > EVENT_TEXT_RETENTION_LIMIT ? value.slice(0, EVENT_TEXT_RETENTION_LIMIT) : value;
}
