import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

/** 요청/응답 해석만 소유한다. local 설치 상태나 재시도 게이트를 건드리지 않는다. */
export async function requestObjective<T>(api: ClientApiCapability, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await api.fetch("objectives", path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  } catch (error) {
    const code = apiErrorCode(error);
    throw code === null ? error : Object.assign(new Error(code), { status: (error as { status: number }).status });
  }
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  signal?.throwIfAborted();
  if (!response.ok) throw Object.assign(new Error(payload?.error ?? `http_${response.status}`), { status: response.status });
  return payload as T;
}

function apiErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  if (record.name !== "ApiError" || typeof record.status !== "number") return null;
  const body = record.body;
  if (typeof body !== "object" || body === null) return null;
  const code = (body as Record<string, unknown>).error;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : null;
}
