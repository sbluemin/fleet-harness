import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  AgentAttentionReason,
  AgentDurableOperation,
  AgentLabelSource,
  AgentModelActivity,
  AgentObservedEvent,
  AgentObservedJob,
  AgentObservedRequest,
  AgentObservedWorkspace,
  AgentObserverTruncation,
  AgentProviderSession,
  AgentProviderTitleMarker,
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
  providerTitle?: AgentProviderTitleMarker;
  autoNamePromptSeen?: boolean;
  cliId?: string;
  cliLabel?: string;
  readonly createdAt: number;
  readonly theaterId: string;
  readonly terminalSessionId: string;
  status: AgentSessionStatus;
  turnState?: AgentTurnState;
  modelActivity?: AgentModelActivity;
  attentionPending?: boolean;
  backgroundPending?: boolean;
  backgroundPendingExpiry?: ReturnType<typeof setTimeout>;
  registrationId?: string;
  cliRunId?: string;
  providerSession?: AgentProviderSession;
}

type DormantOperationInput = AgentDurableOperation;

interface AutoNameTerminalSessionResult {
  readonly session: AgentTerminalSessionInfo;
  readonly renamed: boolean;
}

interface ProviderIdentityTerminalSessionResult {
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
const BACKGROUND_PENDING_TTL_MS = 30 * 60_000;
const REDACTED_REQUEST_PATH = "[redacted path]";

export function createConsoleObservabilityStore(deps: ConsoleObservabilityStoreDeps = {}) {
  const now = deps.now ?? Date.now;
  const nowIso = deps.nowIso ?? (() => new Date(now()).toISOString());
  const canonicalizeTheaterPath = deps.canonicalizeTheaterPath ?? defaultCanonicalizeTheaterPath;
  const workspaceHash = deps.workspaceHash ?? defaultWorkspaceHash;
  const workspacesByCliRunId = new Map<string, WorkspaceState>();
  const workspacesByRegistrationId = new Map<string, WorkspaceState>();
  const terminalSessionsById = new Map<string, PendingTerminalSessionState>();
  const allListeners = new Set<AgentAllEventListener>();

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
    const previous = terminalSessionsById.get(input.sessionId);
    if (previous) clearTerminalSessionBackgroundPending(previous);
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
    const previous = terminalSessionsById.get(operation.sessionId);
    if (previous) clearTerminalSessionBackgroundPending(previous);
    const state: PendingTerminalSessionState = {
      sessionId: operation.sessionId,
      cwd: operation.cwd,
      canonicalCwd: canonicalizeTheaterPath(operation.cwd),
      cwdLabel: path.basename(operation.cwd) || operation.cwd,
      label: operation.label,
      labelSource: operation.labelSource,
      providerTitle: operation.providerTitle,
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
      ...(session.providerTitle ? { providerTitle: session.providerTitle } : {}),
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

  // fresh 시작 직후 이전 provider 세션을 지운다 — 남겨두면 fresh CLI가 새 capture를 쓰기 전에
  // 종료될 때 handleExit이 만료된 세션으로 dormant 복귀하는 스테일 경로가 열린다.
  function clearTerminalSessionProviderSession(sessionId: string): AgentTerminalSessionInfo | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    delete session.providerSession;
    return toTerminalSessionInfo(session);
  }

  function updateTerminalSessionStatus(sessionId: string, status: AgentSessionStatus): AgentTerminalSessionInfo | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    session.status = status;
    if (status === "starting" || status === "dormant") {
      delete session.modelActivity;
      delete session.attentionPending;
    }
    if (status === "dormant" || status === "closed" || status === "error") {
      clearTerminalSessionBackgroundPending(session);
    }
    return toTerminalSessionInfo(session);
  }

  function setTerminalSessionTurnState(sessionId: string, turnState: AgentTurnState): AgentTerminalSessionInfo | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    session.turnState = turnState;
    delete session.modelActivity;
    delete session.attentionPending;
    return toTerminalSessionInfo(session);
  }

  // 살아 있는 백그라운드 작업 보고를 절대값으로 반영한다. 증감이 아니라 대입이므로, 하나의 Workflow가
  // 에이전트 수만큼 stop을 발화해도 남은 작업이 있는 한 pending이 꺼지지 않는다.
  function setTerminalSessionBackgroundPending(sessionId: string, pending: boolean): AgentTerminalSessionInfo | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    // dormant/closed/error 세션에 뒤늦게 도착한 best-effort hook은 무시한다 — 라이프사이클 정리
    // (clearTerminalSessionBackgroundPending) 뒤에 상태·타이머를 되살리면 resume 후 거짓 배지가 남는다.
    if (session.status === "dormant" || session.status === "closed" || session.status === "error") return null;
    if (!pending) {
      // 꺼질 때는 만료 타이머도 함께 정리한다 — 30분 뒤 무의미한 false→false notify를 남기지 않는다.
      clearTerminalSessionBackgroundPending(session);
      return toTerminalSessionInfo(session);
    }
    session.backgroundPending = true;
    if (session.backgroundPendingExpiry) clearTimeout(session.backgroundPendingExpiry);
    session.backgroundPendingExpiry = setTimeout(() => {
      session.backgroundPending = false;
      delete session.backgroundPendingExpiry;
      notifySessionUpdated(toTerminalSessionInfo(session));
    }, BACKGROUND_PENDING_TTL_MS);
    if (typeof session.backgroundPendingExpiry.unref === "function") session.backgroundPendingExpiry.unref();
    return toTerminalSessionInfo(session);
  }

  function setTerminalSessionModelActivity(sessionId: string, modelActivity: AgentModelActivity): AgentTerminalSessionInfo | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    const clearsAttention = modelActivity === "working" && session.attentionPending === true;
    if (session.modelActivity === modelActivity && !clearsAttention) return null;
    session.modelActivity = modelActivity;
    if (clearsAttention) delete session.attentionPending;
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
    delete session.modelActivity;
    clearTerminalSessionBackgroundPending(session);
    // attentionPending은 보존한다 — dormant 사이드바 "입력 대기" 배지가 Resume 전까지 유지되어야 한다.
    // resume 실패 롤백용 updateTerminalSessionStatus("dormant") 분기는 기존처럼 attention을 지운다.
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
      delete session.providerTitle;
    } else {
      session.label = label;
      session.labelSource = "user";
      delete session.providerTitle;
    }
    return toTerminalSessionInfo(session);
  }

  // 자동 작명: 사용자 수동 또는 provider 라벨이 없는 세션의 첫 유효 프롬프트에만 적용한다.
  // labelSource 미설정 레거시 세션은 label 유무로 보수 해석해 기존 사용자 라벨을 보호한다.
  // 처리 여부는 패널의 인메모리 상태에만 남기며 durable operation에는 포함하지 않는다.
  function autoNameTerminalSession(sessionId: string, label: string | null): AutoNameTerminalSessionResult | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    const effectiveSource: AgentLabelSource | undefined = session.labelSource ?? (session.label ? "user" : undefined);
    if (effectiveSource === "user" || session.providerTitle || session.autoNamePromptSeen) {
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

  // Provider metadata may replace default, auto, or a prior provider title, but
  // never a manual/legacy title. Its provenance remains durable server-only.
  function applyTerminalSessionProviderIdentity(sessionId: string, rawLabel: string | null): ProviderIdentityTerminalSessionResult | null {
    const session = terminalSessionsById.get(sessionId);
    if (!session) return null;
    const label = rawLabel?.trim().slice(0, 200) ?? "";
    if (label.length === 0) return { session: toTerminalSessionInfo(session), renamed: false };

    const isLegacyOrUserTitle = session.labelSource === "user"
      || (!session.labelSource && !session.providerTitle && Boolean(session.label));
    if (isLegacyOrUserTitle) return { session: toTerminalSessionInfo(session), renamed: false };
    if (session.label === label && session.providerTitle) {
      return { session: toTerminalSessionInfo(session), renamed: false };
    }

    session.label = label;
    delete session.labelSource;
    session.providerTitle = { source: "provider" };
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
    const state = terminalSessionsById.get(session.sessionId);
    if (state && reason !== "idle_prompt") state.attentionPending = true;
    const event: AgentSessionAttentionEvent = {
      type: "session:attention",
      session: state ? toTerminalSessionInfo(state) : session,
      reason,
    };
    // 입력 대기 알림은 1회성 신호다. session:updated와 같은 aggregate 경로로 흘린다.
    for (const listener of allListeners) listener(event);
  }

  function clearTerminalSessionBackgroundPending(session: PendingTerminalSessionState): void {
    if (session.backgroundPendingExpiry) clearTimeout(session.backgroundPendingExpiry);
    delete session.backgroundPendingExpiry;
    session.backgroundPending = false;
  }

  function removeTerminalSession(sessionId: string): boolean {
    const session = terminalSessionsById.get(sessionId);
    if (session) clearTerminalSessionBackgroundPending(session);
    const workspace = workspacesByCliRunId.get(sessionId);
    if (workspace?.terminalSessionId === sessionId) {
      removeWorkspaceIndexes(workspace);
      workspacesByCliRunId.delete(sessionId);
    }
    return terminalSessionsById.delete(sessionId);
  }

  function clear(): void {
    for (const session of terminalSessionsById.values()) clearTerminalSessionBackgroundPending(session);
    workspacesByCliRunId.clear();
    workspacesByRegistrationId.clear();
    terminalSessionsById.clear();
    allListeners.clear();
  }

  return {
    clear,
    getLaunchCwd,
    getDurableOperation,
    getWorkspace,
    listDurableOperations,
    listTerminalSessions,
    listWorkspaces,
    createPendingTerminalSession,
    getTerminalSessionInfo,
    injectDormantOperation,
    notifySessionAttention,
    notifySessionUpdated,
    renameTerminalSession,
    autoNameTerminalSession,
    applyTerminalSessionProviderIdentity,
    subscribeAll,
    updateTerminalSessionProviderSession,
    clearTerminalSessionProviderSession,
    updateTerminalSessionStatus,
    setTerminalSessionTurnState,
    setTerminalSessionBackgroundPending,
    setTerminalSessionModelActivity,
    transitionTerminalSessionToDormant,
    removeTerminalSession,
    registerTerminalRuntimeSession,
    workspaceCount: () => listWorkspaces().length,
  };

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
    ...(state.modelActivity ? { modelActivity: state.modelActivity } : {}),
    ...(state.attentionPending === true ? { attentionPending: true } : {}),
    ...(state.backgroundPending === true ? { backgroundPending: true } : {}),
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
      {
        const request = normalizeRequest(obj.request);
      return {
        type: "track:begin",
        jobId: safeString(obj.jobId),
        trackId: safeString(obj.trackId),
        startedAt: safeOptionalNumber(obj.startedAt),
        ...(request ? { request } : {}),
        requestPreview: typeof obj.requestPreview === "string" ? redactRequestPaths(obj.requestPreview) : undefined,
      };
      }
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

function normalizeRequest(value: unknown): AgentObservedRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const request = value as Record<string, unknown>;
  if (!Array.isArray(request.blocks) || typeof request.additional !== "string") return undefined;

  const blocks: AgentObservedRequest["blocks"][number][] = [];
  for (const value of request.blocks) {
    if (typeof value !== "object" || value === null) return undefined;
    const block = value as Record<string, unknown>;
    if (
      typeof block.tag !== "string"
      || typeof block.hint !== "string"
      || typeof block.required !== "boolean"
      || typeof block.present !== "boolean"
      || typeof block.body !== "string"
    ) return undefined;
    blocks.push({
      tag: block.tag,
      hint: block.hint,
      required: block.required,
      present: block.present,
      body: redactRequestPaths(block.body),
    });
  }
  return { blocks, additional: redactRequestPaths(request.additional) };
}

function redactRequestPaths(value: string): string {
  let copyStart = 0;
  let cursor = 0;
  const parts: string[] = [];
  // URL과 경로로 판정한 구간은 끝까지 건너뛰어 입력과 결과 조립을 각각 한 번의 선형 순회로 제한한다.
  while (cursor < value.length) {
    const ordinaryUrlEnd = readOrdinaryUrlEnd(value, cursor);
    if (ordinaryUrlEnd !== undefined) {
      cursor = ordinaryUrlEnd;
      continue;
    }
    const pathEnd = readFilesystemPathEnd(value, cursor);
    if (pathEnd === undefined) {
      cursor += 1;
      continue;
    }
    parts.push(value.slice(copyStart, cursor), REDACTED_REQUEST_PATH);
    copyStart = pathEnd;
    cursor = pathEnd;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(copyStart));
  return parts.join("");
}

function readOrdinaryUrlEnd(value: string, start: number): number | undefined {
  if (!isAsciiLetter(value[start]) || (start > 0 && isUriSchemeCharacter(value[start - 1]))) return undefined;
  let cursor = start + 1;
  while (cursor < value.length && isUriSchemeCharacter(value[cursor])) cursor += 1;
  if (value[cursor] !== ":" || value[cursor + 1] !== "/" || value[cursor + 2] !== "/") return undefined;
  if (value.slice(start, cursor).toLowerCase() === "file") return undefined;
  cursor += 3;
  while (cursor < value.length && !isPathTerminator(value[cursor])) cursor += 1;
  return cursor;
}

function readFilesystemPathEnd(value: string, start: number): number | undefined {
  const previous = start > 0 ? value[start - 1] : undefined;
  const boundary = start === 0 || isPathBoundary(previous);
  const explicitBoundary = boundary || previous === "<";
  if (
    explicitBoundary
    && value.slice(start, start + 7).toLowerCase() === "file://"
  ) return scanPathEnd(value, start, start + 7, previous);

  if (
    explicitBoundary
    && isAsciiLetter(value[start])
    && value[start + 1] === ":"
    && (value[start + 2] === "/" || value[start + 2] === "\\")
  ) return scanPathEnd(value, start, start + 3, previous);

  if (
    explicitBoundary
    && value[start] === "\\"
    && value[start + 1] === "\\"
    && value[start + 2] !== undefined
    && !isPathTerminator(value[start + 2])
  ) return scanPathEnd(value, start, start + 2, previous);

  if (
    explicitBoundary
    && value[start] === "\\"
    && value[start + 1] !== undefined
    && value[start + 1] !== "\\"
    && !isPathTerminator(value[start + 1])
  ) return scanPathEnd(value, start, start + 1, previous);

  if (explicitBoundary && value[start] === "~") {
    let separator = start + 1;
    while (separator < value.length && isHomeUserCharacter(value[separator])) separator += 1;
    if (value[separator] === "/" || value[separator] === "\\") return scanPathEnd(value, start, separator + 1, previous);
  }

  if (
    explicitBoundary
    && value[start] === "/"
    && value[start + 1] === "/"
    && value[start + 2] !== undefined
    && !isPathTerminator(value[start + 2])
  ) return scanPathEnd(value, start, start + 2, previous);

  if (
    boundary
    && value[start] === "/"
    && value[start + 1] !== undefined
    && value[start + 1] !== "/"
    && !isPathTerminator(value[start + 1])
  ) return scanPathEnd(value, start, start + 1, previous);

  return undefined;
}

function scanPathEnd(value: string, start: number, minimumEnd: number, previous: string | undefined): number {
  const quote = previous === "\"" || previous === "'" || previous === "`" ? previous : undefined;
  let cursor = minimumEnd;
  while (cursor < value.length) {
    const character = value[cursor];
    if (quote ? character === quote || character === "\n" || character === "\r" : isPathTerminator(character)) break;
    cursor += 1;
  }
  if (quote) return cursor;
  while (cursor > minimumEnd && ".,;:!?)]}".includes(value[cursor - 1]!)) cursor -= 1;
  return Math.max(cursor, start + 1);
}

function isPathBoundary(value: string | undefined): boolean {
  return value !== undefined
    && value !== "<"
    && value !== "/"
    && value !== "\\"
    && value !== "."
    && value !== "~"
    && value !== "_"
    && !isAsciiLetter(value)
    && !(value >= "0" && value <= "9");
}

function isPathTerminator(value: string | undefined): boolean {
  return value === undefined || /\s/.test(value) || value === "<" || value === ">" || value === "\"" || value === "'" || value === "`" || value === "|";
}

function isAsciiLetter(value: string | undefined): boolean {
  return value !== undefined && ((value >= "A" && value <= "Z") || (value >= "a" && value <= "z"));
}

function isHomeUserCharacter(value: string | undefined): boolean {
  return value !== undefined && (isAsciiLetter(value) || (value >= "0" && value <= "9") || value === "_" || value === "." || value === "-");
}

function isUriSchemeCharacter(value: string | undefined): boolean {
  return value !== undefined && (isAsciiLetter(value) || (value >= "0" && value <= "9") || value === "+" || value === "-" || value === ".");
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
