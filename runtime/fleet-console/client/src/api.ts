import type { ObservedTenant, SnapshotTenantJobs } from "./types.js";

/** HTTP status를 보존하는 observer API 오류 — 인증 실패(401/403) 분기에 필요하다. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

export async function fetchTenants(token: string, signal?: AbortSignal): Promise<readonly ObservedTenant[]> {
  const response = await fetch("/observer/tenants", { headers: authHeaders(token), signal });
  await assertOk(response);
  return ((await response.json()) as { tenants: readonly ObservedTenant[] }).tenants;
}

export async function fetchJobs(token: string, signal?: AbortSignal): Promise<readonly SnapshotTenantJobs[]> {
  const response = await fetch("/observer/jobs", { headers: authHeaders(token), signal });
  await assertOk(response);
  return ((await response.json()) as { tenants: readonly SnapshotTenantJobs[] }).tenants;
}

export async function openEventsStream(token: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch("/observer/events", { headers: authHeaders(token), signal });
  await assertOk(response);
  if (!response.body) throw new ApiError(response.status, "Observer stream unavailable");
  return response.body.getReader();
}

export async function requestTerminalTicket(token: string, signal?: AbortSignal): Promise<{ readonly ticket: string; readonly ttlMs: number }> {
  const response = await fetch("/terminal/ticket", { method: "POST", headers: authHeaders(token), signal });
  await assertOk(response);
  const payload = (await response.json()) as { ticket?: unknown; ttlMs?: unknown };
  if (typeof payload.ticket !== "string" || typeof payload.ttlMs !== "number") {
    throw new ApiError(response.status, "Invalid terminal ticket response");
  }
  return { ticket: payload.ticket, ttlMs: payload.ttlMs };
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
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
