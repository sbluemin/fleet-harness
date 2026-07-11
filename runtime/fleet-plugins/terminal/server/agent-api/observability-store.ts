import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  AgentAttentionReason,
  AgentDurableOperation,
  AgentLabelSource,
  AgentObservedEvent,
  AgentObservedJob,
  AgentObservedWorkspace,
  AgentObserverTruncation,
  AgentProviderSession,
  AgentSessionAttentionEvent,
  AgentSessionStatus,
  AgentSessionUpdatedEvent,
  AgentTerminalSessionInfo,
  AgentTurnState,
} from "./types.js";

export interface ConsoleObservabilityStoreDeps {
  readonly canonicalizeTheaterPath?: (cwd: string) => string;
  readonly now?: () => number;
  readonly nowIso?: () => string;
  readonly workspaceHash?: (canonicalCwd: string) => string;
}

interface WorkspaceInfo {
  readonly registrationId: string;
  readonly cliRunId: string;
  readonly tenantLabel: string;
  readonly cwd: string;
  readonly registeredAt: string;
  readonly mcp?: {
    readonly servers?: readonly {
      readonly name: string;
      readonly toolCount: number;
    }[];
  };
}

interface WorkspaceState {
  readonly session: WorkspaceInfo;
  readonly theaterId: string;
  readonly terminalSessionId?: string;
}

interface PendingTerminalSessionState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly canonicalCwd: string;
  readonly cwdLabel: string;
  label?: string;
  labelSource?: AgentLabelSource;
  autoNamePromptSeen?: boolean;
  cliId?: string;
  cliLabel?: string;
  readonly createdAt: number;
  readonly theaterId: string;
  readonly terminalSessionId: string;
  status: AgentSessionStatus;
  turnState?: AgentTurnState;
  registrationId?: string;
  cliRunId?: string;
  providerSession?: AgentProviderSession;
}

type DormantOperationInput = AgentDurableOperation;

interface AutoNameTerminalSessionResult {
  readonly session: AgentTerminalSessionInfo;
  readonly renamed: boolean;
}

interface TenantJobState {
  readonly jobs: Map<string, AgentObservedJob>;
  readonly finalizedOrder: string[];
}

type AgentObservedEventListener = (event: AgentObservedEvent) => void;
type AgentAllEventListener = (event: AgentObservedEvent | AgentSessionUpdatedEvent | AgentSessionAttentionEvent) => void;

const TENANT_EVENT_LIMIT = 1_000;
const JOB_EVENT_LIMIT = 200;
const TENANT_FINALIZED_JOB_LIMIT = 100;
const TENANT_JOB_LIMIT = 200;
const EVENT_TEXT_RETENTION_LIMIT = 8_192;

export function createConsoleObservabilityStore(deps: ConsoleObservabilityStoreDeps = {}) {
  const now = deps.now ?? Date.now;
  const nowIso = deps.nowIso ?? (() => new Date(now()).toISOString());
  const canonicalizeTheaterPath = deps.canonicalizeTheaterPath ?? defaultCanonicalizeTheaterPath;
  const workspaceHash = deps.workspaceHash ?? defaultWorkspaceHash;
  const workspacesByCliRunId = new Map<string, WorkspaceState>();
  const workspacesByRegistrationId = new Map<string, WorkspaceState>();
  const eventsByTenant = new Map<string, AgentObservedEvent[]>();
  const truncationByTenant = new Map<string, AgentObserverTruncation>();
  const jobsByTenant = new Map<string, TenantJobState>();
  const terminalSessionsById = new Map<string, PendingTerminalSessionState>();
  const listenersByTenant = new Map<string, Set<AgentObservedEventListener>>();
  const allListeners = new Set<AgentAllEventListener>();
  let nextObservedId = 1;

  function append(tenantId: string, rawEvent: unknown, at = now()): AgentObservedEvent {
    const eventObject = typeof rawEvent === "object" && rawEvent !== null ? rawEvent as Record<string, unknown> : {};
    const event: AgentObservedEvent = {
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

  function registerTerminalRuntimeSession(input: { readonly sessionId: string; readonly cliId?: string; readonly cliLabel?: string; readonly label: string; readonly mcpToolCount: number }): AgentTerminalSessionInfo | null {
    const terminalSession = terminalSessionsById.get(input.sessionId);
    if (!terminalSession) return null;
    const previous = workspacesByCliRunId.get(input.sessionId);
    if (previous) removeWorkspaceIndexes(previous);
    const registeredAt = nowIso();
    const session: WorkspaceInfo = {
      registrationId: input.sessionId,
      cliRunId: input.sessionId,
      tenantLabel: input.label,
      cwd: terminalSession.cwd,
      registeredAt,
      mcp: { servers: [{ name: "fleet", toolCount: input.mcpToolCount }] },
    };
    const state: WorkspaceState = {
      session,
      theaterId: terminalSession.theaterId,
      terminalSessionId: terminalSession.terminalSessionId,
    };
    terminalSession.status = "registered";
    terminalSession.cliId = input.cliId;
    terminalSession.cliLabel = input.cliLabel;
    terminalSession.registrationId = session.registrationId;
    terminalSession.cliRunId = session.cliRunId;
    workspacesByCliRunId.set(session.cliRunId, state);
    workspacesByRegistrationId.set(session.registrationId, state);
    return toTerminalSessionInfo(terminalSession);
  }

  function appendTerminalRuntimeEvent(sessionId: string, rawEvent: unknown, at = now()): AgentObservedEvent | null {
    if (!workspacesByCliRunId.has(sessionId)) return null;
    return append(sessionId, rawEvent, at);
  }

  function listWorkspaces(): readonly AgentObservedWorkspace[] {
    return Array.from(workspacesByCliRunId.values())
      .map((workspace) => ({
        tenantId: workspace.session.cliRunId,
        tenantLabel: workspace.session.tenantLabel,
        createdAt: Date.parse(workspace.session.registeredAt),
        sessions: 1,
        status: "live" as const,
        cliRunId: workspace.session.cliRunId,
        registrationId: workspace.session.registrationId,
        theaterId: workspace.theaterId,
        terminalSessionId: workspace.terminalSessionId,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function getWorkspace(tenantId: string): AgentObservedWorkspace | null {
    return listWorkspaces().find((workspace) => workspace.tenantId === tenantId) ?? null;
  }

  function listEvents(tenantId: string): readonly AgentObservedEvent[] {
    return eventsByTenant.get(tenantId) ?? [];
  }

  function listJobs(tenantId: string): readonly AgentObservedJob[] {
    return Array.from(getTenantJobState(tenantId).jobs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function getTruncation(tenantId: string): AgentObserverTruncation {
    return truncationByTenant.get(tenantId) ?? { droppedCount: 0 };
  }

  function subscribe(tenantId: string, listener: AgentObservedEventListener): () => void {
    const listeners = listenersByTenant.get(tenantId) ?? new Set();
    listeners.add(listener);
    listenersByTenant.set(tenantId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) listenersByTenant.delete(tenantId);
    };
  }

  function subscribeAll(listener: AgentAllEventListener): () => void {
    allListeners.add(listener);
    return () => {
      allListeners.delete(listener);
    };
  }

  function getLaunchCwd(sessionId: string): string | null {
    return terminalSessionsById.get(sessionId)?.cwd
      ?? workspacesByCliRunId.get(sessionId)?.session.cwd
      ?? null;
  }

  function createPendingTerminalSession(input: { readonly sessionId: string; readonly cwd: string; readonly cliId?: string; readonly createdAt?: number }): AgentTerminalSessionInfo {
    if (!path.isAbsolute(input.cwd)) throw new Error("Terminal session cwd must be absolute");
    const createdAt = input.createdAt ?? now();
    const canonicalCwd = canonicalizeTheaterPath(input.cwd);
    const theaterId = workspaceHash(canonicalCwd);
    const state: PendingTerminalSessionState = {
      sessionId: input.sessionId,
      cwd: input.cwd,
      canonicalCwd,
      cwdLabel: path.basename(input.cwd) || input.cwd,
      cliId: input.cliId,
      createdAt,
      theaterId,
      terminalSessionId: input.sessionId,
      status: "starting",
    };
    terminalSessionsById.set(state.sessionId, state);
    return toTerminalSessionInfo(state);
  }

  function injectDormantOperation(operation: DormantOperationInput): AgentTerminalSessionInfo {
    const state: PendingTerminalSessionState = {
      sessionId: operation.sessionId,
      cwd: operation.cwd,
      canonicalCwd: canonicalizeTheaterPath(operation.cwd),
      cwdLabel: path.basename(operation.cwd) || operation.cwd,
      label: operation.label,
      labelSource: operation.labelSource,
      cliId: operation.cliId,
      cliLabel: operation.cliLabel,
      createdAt: operation.createdAt,
      theaterId: operation.theaterId,
      terminalSessionId: operation.sessionId,
      status: "dormant",
      providerSession: operation.providerSession,
    };
    terminalSessionsById.set(state.sessionId, state);
    return toTerminalSessionInfo(state);
  }

  function listTerminalSessions(): readonly AgentTerminalSessionInfo[] {
    return Array.from(terminalSessionsById.values()).map(toTerminalSessionInfo).sort((a, b) => b.createdAt - a.createdAt);
  }

  function listDurableOperations(): readonly AgentDurableOperation[] {
    return Array.from(terminalSessionsById.values()).map((session) => ({
      sessionId: session.sessionId,
      theaterId: session.theaterId,
      cwd: session.cwd,
      ...(session.label ? { label: session.label } : {}),
      ...(session.labelSource ? { labelSource: session.labelSource } : {}),
      ...(session.cliId ? { cliId: session.cliId } : {}),
      ...(session.cliLabel ? { cliLabel: session.cliLabel } : {}),
      createdAt: session.createdAt,
      ...(session.providerSession ? { providerSession: session.providerSession } : {}),
    }));
  }

  function getDurableOperation(sessionId: string): AgentDurableOperation | null {
    return listDurableOperations().find((operation) => operation.sessionId === sessionId) ?? null;
  }

  function updateTerminalSessionProviderSession(sessionId: string, providerSession: AgentProviderSession): AgentTerminalSessionInfo | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    session.providerSession = providerSession;
    return toTerminalSessionInfo(session);
  }

  function updateTerminalSessionStatus(sessionId: string, status: AgentSessionStatus): AgentTerminalSessionInfo | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    session.status = status;
    return toTerminalSessionInfo(session);
  }

  function setTerminalSessionTurnState(sessionId: string, turnState: AgentTurnState): AgentTerminalSessionInfo | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    session.turnState = turnState;
    return toTerminalSessionInfo(session);
  }

  function transitionTerminalSessionToDormant(sessionId: string, providerSession: AgentProviderSession): AgentTerminalSessionInfo | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    const workspace = workspacesByCliRunId.get(sessionId);
    if (workspace?.terminalSessionId === sessionId) {
      removeWorkspaceIndexes(workspace);
      workspacesByCliRunId.delete(sessionId);
    }
    session.status = "dormant";
    session.providerSession = providerSession;
    return toTerminalSessionInfo(session);
  }

  function renameTerminalSession(sessionId: string, rawLabel: string): AgentTerminalSessionInfo | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    const label = rawLabel.trim().slice(0, 200);
    if (label.length === 0) {
      // 빈 rename은 사용자가 기본 표시명으로 되돌린 것이다. label과 labelSource를 함께 지워
      // 다음 프롬프트부터 자동 작명이 재활성화되게 한다.
      delete session.label;
      delete session.labelSource;
    } else {
      session.label = label;
      session.labelSource = "user";
    }
    return toTerminalSessionInfo(session);
  }

  // 자동 작명: 사용자 수동 라벨(labelSource "user")이 없는 세션의 첫 유효 프롬프트에만 적용한다.
  // labelSource 미설정 레거시 세션은 label 유무로 보수 해석해 기존 사용자 라벨을 보호한다.
  // 처리 여부는 패널의 인메모리 상태에만 남기며 durable operation에는 포함하지 않는다.
  function autoNameTerminalSession(sessionId: string, label: string | null): AutoNameTerminalSessionResult | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    const effectiveSource: AgentLabelSource | undefined = session.labelSource ?? (session.label ? "user" : undefined);
    if (effectiveSource === "user" || session.autoNamePromptSeen) {
      return { session: toTerminalSessionInfo(session), renamed: false };
    }
    const next = label?.trim().slice(0, 200) ?? "";
    if (next.length === 0) {
      return { session: toTerminalSessionInfo(session), renamed: false };
    }
    session.autoNamePromptSeen = true;
    if (next === session.label) return { session: toTerminalSessionInfo(session), renamed: false };
    session.label = next;
    session.labelSource = "auto";
    return { session: toTerminalSessionInfo(session), renamed: true };
  }

  function notifySessionUpdated(session: AgentTerminalSessionInfo): void {
    const event: AgentSessionUpdatedEvent = { type: "session:updated", session };
    // 세션 메타 프레임은 job observedId 흐름과 분리해 aggregate 구독자에게만 흘린다.
    for (const listener of allListeners) listener(event);
  }

  function getTerminalSessionInfo(sessionId: string): AgentTerminalSessionInfo | null {
    const session = terminalSessionsById.get(sessionId);
    return session ? toTerminalSessionInfo(session) : null;
  }

  function notifySessionAttention(session: AgentTerminalSessionInfo, reason?: AgentAttentionReason): void {
    const event: AgentSessionAttentionEvent = { type: "session:attention", session, reason };
    // 입력 대기 알림은 1회성 신호다. session:updated와 같은 aggregate 경로로 흘리되 세션 메타는 갱신하지 않는다.
    for (const listener of allListeners) listener(event);
  }

  function removeTerminalSession(sessionId: string): boolean {
    const workspace = workspacesByCliRunId.get(sessionId);
    if (workspace?.terminalSessionId === sessionId) {
      removeWorkspaceIndexes(workspace);
      workspacesByCliRunId.delete(sessionId);
    }
    return terminalSessionsById.delete(sessionId);
  }

  function clear(): void {
    workspacesByCliRunId.clear();
    workspacesByRegistrationId.clear();
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
    getLaunchCwd,
    getTruncation,
    getDurableOperation,
    getWorkspace,
    listEvents,
    listJobs,
    listDurableOperations,
    listTerminalSessions,
    listWorkspaces,
    appendTerminalRuntimeEvent,
    createPendingTerminalSession,
    getTerminalSessionInfo,
    injectDormantOperation,
    notifySessionAttention,
    notifySessionUpdated,
    renameTerminalSession,
    autoNameTerminalSession,
    subscribe,
    subscribeAll,
    updateTerminalSessionProviderSession,
    updateTerminalSessionStatus,
    setTerminalSessionTurnState,
    transitionTerminalSessionToDormant,
    removeTerminalSession,
    registerTerminalRuntimeSession,
    workspaceCount: () => listWorkspaces().length,
  };

  function storeObservedEvent(event: AgentObservedEvent): void {
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
    const created = { jobs: new Map<string, AgentObservedJob>(), finalizedOrder: [] };
    jobsByTenant.set(tenantId, created);
    return created;
  }

  function updateJobSnapshot(tenantId: string, event: AgentObservedEvent): void {
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
  }
}

function toTerminalSessionInfo(state: PendingTerminalSessionState): AgentTerminalSessionInfo {
  return {
    sessionId: state.sessionId,
    terminalSessionId: state.terminalSessionId,
    cwdLabel: state.cwdLabel,
    label: state.label,
    labelSource: state.labelSource,
    cliId: state.cliId,
    cliLabel: state.cliLabel,
    status: state.status,
    turnState: state.turnState ?? "none",
    createdAt: state.createdAt,
    theaterId: state.theaterId,
    registrationId: state.registrationId,
    cliRunId: state.cliRunId,
    tenantId: state.cliRunId,
    resumeAvailable: state.providerSession !== undefined,
  };
}

function defaultWorkspaceHash(canonicalCwd: string): string {
  return crypto.createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 12);
}

function defaultCanonicalizeTheaterPath(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
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
  switch (obj.type) {
    case "job:registered":
      return {
        type: "job:registered",
        jobId: safeString(obj.jobId),
        kind: safeString(obj.kind),
        ownerCarrierId: safeString(obj.ownerCarrierId),
        label: safeString(obj.label),
        startedAt: safeNumber(obj.startedAt),
        activeJobToolCallId: safeOptionalString(obj.activeJobToolCallId),
        tracks: Array.isArray(obj.tracks) ? obj.tracks.map(normalizeTrackMeta) : [],
        signatureCli: safeOptionalString(obj.signatureCli),
      };
    case "job:finalized":
      return {
        type: "job:finalized",
        jobId: safeString(obj.jobId),
        status: safeString(obj.status),
        finishedAt: safeNumber(obj.finishedAt),
        error: safeOptionalString(obj.error),
        summary: safeString(obj.summary),
      };
    case "track:begin":
      return {
        type: "track:begin",
        jobId: safeString(obj.jobId),
        trackId: safeString(obj.trackId),
        startedAt: safeOptionalNumber(obj.startedAt),
        requestPreview: safeOptionalString(obj.requestPreview),
      };
    case "track:status":
      return {
        type: "track:status",
        jobId: safeString(obj.jobId),
        trackId: safeString(obj.trackId),
        status: safeString(obj.status),
      };
    case "track:runId":
      return {
        type: "track:runId",
        jobId: safeString(obj.jobId),
        trackId: safeString(obj.trackId),
        runId: safeString(obj.runId),
      };
    case "track:text":
    case "track:thought":
      return {
        type: obj.type,
        jobId: safeString(obj.jobId),
        trackId: safeString(obj.trackId),
        text: clampText(obj.text),
        textLength: typeof obj.text === "string" ? obj.text.length : 0,
      };
    case "track:tool":
      return {
        type: "track:tool",
        jobId: safeString(obj.jobId),
        trackId: safeString(obj.trackId),
        detailChars: safeOptionalNumber(obj.detailChars),
        toolCallId: safeOptionalString(obj.toolCallId),
        title: safeString(obj.title),
        status: safeString(obj.status),
      };
    case "track:finalized":
      return {
        type: "track:finalized",
        jobId: safeString(obj.jobId),
        trackId: safeString(obj.trackId),
        status: safeString(obj.status),
        finishedAt: safeOptionalNumber(obj.finishedAt),
        error: safeOptionalString(obj.error),
        sessionId: safeOptionalString(obj.sessionId),
        fallbackText: clampText(obj.fallbackText),
        fallbackTextLength: typeof obj.fallbackText === "string" ? obj.fallbackText.length : undefined,
        fallbackThought: clampText(obj.fallbackThought),
        fallbackThoughtLength: typeof obj.fallbackThought === "string" ? obj.fallbackThought.length : undefined,
      };
    default:
      return { type: safeString(obj.type) || "event" };
  }
}

function clampText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > EVENT_TEXT_RETENTION_LIMIT ? value.slice(0, EVENT_TEXT_RETENTION_LIMIT) : value;
}

function normalizeTrackMeta(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  const track = value as Record<string, unknown>;
  return {
    trackId: safeString(track.trackId),
    streamKey: safeString(track.streamKey),
    displayCli: safeString(track.displayCli),
    displayName: safeString(track.displayName),
    effort: safeOptionalString(track.effort),
    model: safeOptionalString(track.model),
    subtitle: safeOptionalString(track.subtitle),
    startedAt: safeOptionalNumber(track.startedAt),
    kind: safeString(track.kind),
    runId: safeOptionalString(track.runId),
  };
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
