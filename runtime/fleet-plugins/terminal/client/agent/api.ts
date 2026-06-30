import type { OperationNode } from "@fleet-console/sdk/operations";
import type { AgentCliMetadata, AgentCliState, ObservedTenant, SessionInfo, SnapshotTenantJobs } from "./types.js";

export interface OperationsSnapshot {
  readonly operations: readonly OperationNode[];
}

const FORBIDDEN_BROWSER_PAYLOAD_KEYS = ["canonicalCwd", "cwd", "providerSession", "ticket", "token", "transcriptPath", "prompt", "persona", "toolAllowlist"] as const;

export class AgentApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AgentApiError";
    this.status = status;
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

export async function fetchTenants(signal?: AbortSignal): Promise<readonly ObservedTenant[]> {
  const response = await fetch("/plugins/terminal/agent/tenants", { signal });
  await assertOk(response);
  const payload = await response.json() as { readonly tenants?: unknown };
  if (!Array.isArray(payload.tenants)) throw new AgentApiError(response.status, "Invalid tenants response");
  return payload.tenants.map((tenant) => assertObservedTenant(tenant, response.status));
}

export async function fetchJobs(signal?: AbortSignal): Promise<readonly SnapshotTenantJobs[]> {
  const response = await fetch("/plugins/terminal/agent/jobs", { signal });
  await assertOk(response);
  const payload = await response.json() as { readonly tenants?: unknown };
  if (!Array.isArray(payload.tenants)) throw new AgentApiError(response.status, "Invalid jobs response");
  return payload.tenants as readonly SnapshotTenantJobs[];
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

export async function createAgentSession(theaterId: string, cliId: string, signal?: AbortSignal): Promise<SessionInfo> {
  const response = await fetch("/plugins/terminal/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theaterId, cliId }),
    signal,
  });
  await assertOk(response);
  return assertSessionInfo(await response.json(), response.status);
}

export async function renameAgentSession(sessionId: string, label: string, signal?: AbortSignal): Promise<SessionInfo> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
    signal,
  });
  await assertOk(response);
  return assertSessionInfo(await response.json(), response.status);
}

export async function resumeAgentSession(sessionId: string, signal?: AbortSignal): Promise<SessionInfo> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/resume`, { method: "POST", signal });
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
    || typeof payload.sequence !== "number"
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
    sequence: payload.sequence,
    label: typeof payload.label === "string" ? payload.label : undefined,
    cliId: typeof payload.cliId === "string" ? payload.cliId : undefined,
    cliLabel: typeof payload.cliLabel === "string" ? payload.cliLabel : undefined,
    status: payload.status,
    turnState: payload.turnState === "running" || payload.turnState === "ended" ? payload.turnState : "none",
    createdAt: payload.createdAt,
    theaterId: typeof payload.theaterId === "string" ? payload.theaterId : undefined,
    tenantId: typeof payload.tenantId === "string" ? payload.tenantId : undefined,
    registrationId: typeof payload.registrationId === "string" ? payload.registrationId : undefined,
    resumeAvailable: payload.resumeAvailable === true,
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

function assertObservedTenant(value: unknown, status: number): ObservedTenant {
  const payload = value as Partial<ObservedTenant>;
  if (!payload || typeof payload.tenantId !== "string" || typeof payload.tenantLabel !== "string" || typeof payload.createdAt !== "number" || typeof payload.sessions !== "number") {
    throw new AgentApiError(status, "Invalid tenant response");
  }
  return payload as ObservedTenant;
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
    renamedTitle: typeof payload.renamedTitle === "string" ? payload.renamedTitle : undefined,
    payload: payload.payload,
    geometry: payload.geometry ?? null,
    state: payload.state && typeof payload.state === "object" && !Array.isArray(payload.state) ? payload.state : {},
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
