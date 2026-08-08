import type { OperationNode } from "@fleet-console/sdk/operations";
import type { AgentCliDiagnostics, AgentCliMetadata, AgentCliState, SessionGoal, SessionInfo } from "./types.js";

export interface OperationsSnapshot {
  readonly operations: readonly OperationNode[];
}

const FORBIDDEN_BROWSER_PAYLOAD_KEYS = ["canonicalCwd", "cwd", "providerSession", "ticket", "token", "transcriptPath", "prompt", "persona", "toolAllowlist"] as const;

export class AgentApiError extends Error {
  readonly status: number;
  /**
   * 거절이 프롬프트를 몇 글자 줄이라고 말할 때 그 수. 서버만 아는 값이라(상한이 그 실행의
   * argv 전체에 달려 있다) 브라우저가 되계산할 수 없어, 코드와 함께 실어 나른다.
   */
  readonly shortenByChars?: number;

  constructor(status: number, message: string, shortenByChars?: number) {
    super(message);
    this.name = "AgentApiError";
    this.status = status;
    if (shortenByChars !== undefined) this.shortenByChars = shortenByChars;
  }
}

export async function fetchAgentState(signal?: AbortSignal): Promise<readonly AgentCliMetadata[]> {
  const response = await fetch("/plugins/terminal/agent/state", { signal });
  await assertOk(response);
  const payload = await response.json() as { readonly agentClis?: unknown };
  if (!Array.isArray(payload.agentClis)) throw new AgentApiError(response.status, "Invalid agent state response");
  return payload.agentClis.map((cli) => assertAgentCliMetadata(cli, response.status));
}

export async function fetchAgentCliState(signal?: AbortSignal): Promise<AgentCliState> {
  const response = await fetch("/plugins/terminal/agent/agent-cli/state", { signal });
  await assertOk(response);
  const payload = await response.json() as AgentCliState;
  if (!Array.isArray(payload.clis)) throw new AgentApiError(response.status, "Invalid Agent CLI state response");
  return payload;
}

export async function fetchAgentCliDiagnostics(signal?: AbortSignal): Promise<AgentCliDiagnostics> {
  const response = await fetch("/plugins/terminal/agent/agent-cli/diagnostics", { signal });
  await assertOk(response);
  const payload = await response.json() as AgentCliDiagnostics;
  if (!Array.isArray(payload.entries)) throw new AgentApiError(response.status, "Invalid Agent CLI diagnostics response");
  return payload;
}

export async function setAgentCliPath(cliCommand: string, path: string | null, signal?: AbortSignal): Promise<void> {
  const response = await fetch("/plugins/terminal/agent/agent-cli/path", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cliCommand, path }),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
    throw new AgentApiError(response.status, typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`);
  }
}

export async function fetchSessions(signal?: AbortSignal): Promise<readonly SessionInfo[]> {
  const response = await fetch("/plugins/terminal/agent/sessions", { signal });
  await assertOk(response);
  const payload = await response.json() as { readonly sessions?: unknown };
  if (!Array.isArray(payload.sessions)) throw new AgentApiError(response.status, "Invalid agent sessions response");
  return payload.sessions.map((session) => assertSessionInfo(session, response.status));
}

export async function fetchOperationsSnapshot(signal?: AbortSignal): Promise<OperationsSnapshot> {
  const response = await fetch("/api/v1/operations", { signal });
  await assertOk(response);
  const payload = await response.json() as { readonly operations?: unknown };
  if (!Array.isArray(payload.operations)) throw new AgentApiError(response.status, "Invalid operations response");
  return { operations: payload.operations.map((operation) => assertOperationNode(operation, response.status)) };
}

export async function createAgentSession(
  theaterId: string,
  cliId: string,
  options?: { readonly model?: string; readonly effort?: string; readonly prompt?: string },
  signal?: AbortSignal,
): Promise<SessionInfo> {
  const model = typeof options?.model === "string" && options.model.length > 0 ? options.model : undefined;
  const effort = typeof options?.effort === "string" && options.effort.length > 0 ? options.effort : undefined;
  // 요청 body에는 prompt를 실을 수 있지만, 응답 DTO에는 절대 오면 안 된다 — FORBIDDEN_BROWSER_PAYLOAD_KEYS의 "prompt"는 응답 가드이므로 지우지 않는다.
  const prompt = typeof options?.prompt === "string" && options.prompt.length > 0 ? options.prompt : undefined;
  const response = await fetch("/plugins/terminal/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theaterId, cliId, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(prompt ? { prompt } : {}) }),
    signal,
  });
  // 거절 사유 코드를 그대로 실어 던진다 — Quick Launch가 초안을 되살리면서 무엇을 고쳐야 하는지
  // 말해 주려면, 상태 코드만으로는 부족하고 서버가 붙인 error 코드가 필요하다(setAgentCliPath와 같은 형태).
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {
      readonly error?: unknown;
      readonly shortenByChars?: unknown;
    } | null;
    throw new AgentApiError(
      response.status,
      typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`,
      typeof payload?.shortenByChars === "number" ? payload.shortenByChars : undefined,
    );
  }
  return assertSessionInfo(await response.json(), response.status);
}


export async function resumeAgentSession(sessionId: string, options?: { readonly fresh?: boolean; readonly signal?: AbortSignal }): Promise<SessionInfo> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
    ...(options?.fresh
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fresh: true }) }
      : {}),
    signal: options?.signal,
  });
  await assertOk(response);
  return assertSessionInfo(await response.json(), response.status);
}

export async function terminateAgentSession(sessionId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", signal });
  await assertOk(response);
}

export function assertSessionInfo(value: unknown, status: number): SessionInfo {
  const payload = value as Partial<SessionInfo>;
  if (
    !payload
    || typeof payload.sessionId !== "string"
    || typeof payload.cwdLabel !== "string"
    || typeof payload.status !== "string"
    || typeof payload.createdAt !== "number"
    || hasForbiddenBrowserPayloadKey(payload)
  ) {
    throw new AgentApiError(status, "Invalid agent session response");
  }
  return {
    sessionId: payload.sessionId,
    terminalSessionId: typeof payload.terminalSessionId === "string" ? payload.terminalSessionId : payload.sessionId,
    cwdLabel: payload.cwdLabel,
    label: typeof payload.label === "string" ? payload.label : undefined,
    cliId: typeof payload.cliId === "string" ? payload.cliId : undefined,
    cliLabel: typeof payload.cliLabel === "string" ? payload.cliLabel : undefined,
    status: payload.status,
    turnState: payload.turnState === "running" || payload.turnState === "ended" ? payload.turnState : "none",
    modelActivity: payload.modelActivity === "working" || payload.modelActivity === "not-working" ? payload.modelActivity : undefined,
    attentionPending: typeof payload.attentionPending === "boolean" ? payload.attentionPending : undefined,
    backgroundPending: typeof payload.backgroundPending === "boolean" ? payload.backgroundPending : undefined,
    createdAt: payload.createdAt,
    theaterId: typeof payload.theaterId === "string" ? payload.theaterId : undefined,
    tenantId: typeof payload.tenantId === "string" ? payload.tenantId : undefined,
    registrationId: typeof payload.registrationId === "string" ? payload.registrationId : undefined,
    resumeAvailable: payload.resumeAvailable === true,
    goal: assertSessionGoal(payload.goal),
  };
}

function assertSessionGoal(value: unknown): SessionGoal | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const goal = value as Partial<SessionGoal>;
  if (
    (goal.state !== "requested" && goal.state !== "active" && goal.state !== "deferred" && goal.state !== "met" && goal.state !== "impossible" && goal.state !== "capped" && goal.state !== "unknown")
    || typeof goal.live !== "boolean"
    || (goal.origin !== "fleet" && goal.origin !== "terminal")
    || typeof goal.checksUsed !== "number"
    || !Number.isFinite(goal.checksUsed)
    || typeof goal.checkLimit !== "number"
    || !Number.isFinite(goal.checkLimit)
  ) return undefined;
  return {
    state: goal.state,
    live: goal.live,
    origin: goal.origin,
    checksUsed: goal.checksUsed,
    checkLimit: goal.checkLimit,
    ...(typeof goal.totalChecks === "number" && Number.isFinite(goal.totalChecks) ? { totalChecks: goal.totalChecks } : {}),
    ...(typeof goal.pendingCheckLimit === "number" && Number.isFinite(goal.pendingCheckLimit) ? { pendingCheckLimit: goal.pendingCheckLimit } : {}),
    ...(typeof goal.condition === "string" ? { condition: goal.condition } : {}),
    ...(typeof goal.durationMs === "number" && Number.isFinite(goal.durationMs) ? { durationMs: goal.durationMs } : {}),
    ...(typeof goal.tokens === "number" && Number.isFinite(goal.tokens) ? { tokens: goal.tokens } : {}),
  };
}

async function assertOk(response: Response): Promise<void> {
  if (!response.ok) throw new AgentApiError(response.status, `Agent plugin request failed: ${response.status}`);
}

function assertAgentCliMetadata(value: unknown, status: number): AgentCliMetadata {
  const payload = value as Partial<AgentCliMetadata>;
  if (!payload || typeof payload.id !== "string" || typeof payload.label !== "string") {
    throw new AgentApiError(status, "Invalid Agent CLI metadata response");
  }
  return {
    id: payload.id,
    label: payload.label,
    available: payload.available === true,
    signedIn: payload.signedIn !== false,
  };
}

function assertOperationNode(value: unknown, status: number): OperationNode {
  const payload = value as Partial<OperationNode>;
  if (
    !payload
    || typeof payload.id !== "string"
    || typeof payload.theaterId !== "string"
    || typeof payload.type !== "string"
    || typeof payload.pluginId !== "string"
    || typeof payload.title !== "string"
    || !payload.payload
    || typeof payload.payload !== "object"
    || Array.isArray(payload.payload)
    || !payload.ts
    || typeof payload.ts.createdAt !== "number"
    || typeof payload.ts.updatedAt !== "number"
    || hasForbiddenBrowserPayloadKey(payload)
    || hasForbiddenBrowserPayloadKey(payload.payload)
  ) {
    throw new AgentApiError(status, "Invalid operation response");
  }
  return {
    id: payload.id,
    theaterId: payload.theaterId,
    type: payload.type,
    pluginId: payload.pluginId,
    title: payload.title,
    payload: payload.payload,
    geometry: payload.geometry ?? null,
    ts: payload.ts,
  };
}

function hasForbiddenBrowserPayloadKey(value: unknown): boolean {
  return containsForbiddenKey(value, new Set(FORBIDDEN_BROWSER_PAYLOAD_KEYS));
}

function containsForbiddenKey(value: unknown, forbidden: ReadonlySet<string>): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenKey(item, forbidden));
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => forbidden.has(key) || containsForbiddenKey(item, forbidden));
}
