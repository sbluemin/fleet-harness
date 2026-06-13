import type { ObservedTenant, SessionInfo, SnapshotTenantJobs } from "./types.js";

/** HTTP status를 보존하는 API 오류. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function fetchTenants(signal?: AbortSignal): Promise<readonly ObservedTenant[]> {
  const response = await fetch("/observer/tenants", { signal });
  await assertOk(response);
  return ((await response.json()) as { tenants: readonly ObservedTenant[] }).tenants;
}

export async function fetchJobs(signal?: AbortSignal): Promise<readonly SnapshotTenantJobs[]> {
  const response = await fetch("/observer/jobs", { signal });
  await assertOk(response);
  return ((await response.json()) as { tenants: readonly SnapshotTenantJobs[] }).tenants;
}

export async function openEventsStream(signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch("/observer/events", { signal });
  await assertOk(response);
  if (!response.body) throw new ApiError(response.status, "Observer stream unavailable");
  return response.body.getReader();
}

export async function pickTerminalFolder(signal?: AbortSignal): Promise<{ readonly folderGrantId: string } | { readonly cancelled: true }> {
  const response = await fetch("/terminal/folders/pick", { method: "POST", signal });
  await assertOk(response);
  const payload = (await response.json()) as { folderGrantId?: unknown; cancelled?: unknown };
  if (payload.cancelled === true) return { cancelled: true };
  if (typeof payload.folderGrantId !== "string") throw new ApiError(response.status, "Invalid folder picker response");
  return { folderGrantId: payload.folderGrantId };
}

export async function createTerminalSession(folderGrantId: string, signal?: AbortSignal): Promise<SessionInfo> {
  const response = await fetch("/terminal/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderGrantId }),
    signal,
  });
  await assertOk(response);
  return assertSessionInfo(await response.json(), response.status);
}

export async function fetchTerminalSessions(signal?: AbortSignal): Promise<readonly SessionInfo[]> {
  const response = await fetch("/terminal/sessions", { signal });
  await assertOk(response);
  const payload = (await response.json()) as { sessions?: unknown };
  if (!Array.isArray(payload.sessions)) throw new ApiError(response.status, "Invalid terminal sessions response");
  return payload.sessions.map((session) => assertSessionInfo(session, response.status));
}

export async function requestTerminalTicket(sessionId: string, signal?: AbortSignal): Promise<{ readonly ticket: string; readonly ttlMs: number }> {
  const response = await fetch("/terminal/ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
    signal,
  });
  await assertOk(response);
  const payload = (await response.json()) as { ticket?: unknown; ttlMs?: unknown };
  if (typeof payload.ticket !== "string" || typeof payload.ttlMs !== "number") {
    throw new ApiError(response.status, "Invalid terminal ticket response");
  }
  return { ticket: payload.ticket, ttlMs: payload.ttlMs };
}

function assertSessionInfo(value: unknown, status: number): SessionInfo {
  const payload = value as Partial<SessionInfo>;
  if (!payload || typeof payload.sessionId !== "string" || typeof payload.cwdLabel !== "string" || typeof payload.status !== "string" || typeof payload.createdAt !== "number") {
    throw new ApiError(status, "Invalid terminal session response");
  }
  return {
    sessionId: payload.sessionId,
    terminalSessionId: typeof payload.terminalSessionId === "string" ? payload.terminalSessionId : payload.sessionId,
    cwdLabel: payload.cwdLabel,
    status: payload.status,
    createdAt: payload.createdAt,
    tenantId: typeof payload.tenantId === "string" ? payload.tenantId : undefined,
    registrationId: typeof payload.registrationId === "string" ? payload.registrationId : undefined,
  };
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let detail = response.statusText;
  try {
    detail = ((await response.json()) as { error?: string }).error ?? detail;
  } catch {
    // 오류 본문은 운영자 안내용 best-effort다.
  }
  throw new ApiError(response.status, detail || `HTTP ${response.status}`);
}
