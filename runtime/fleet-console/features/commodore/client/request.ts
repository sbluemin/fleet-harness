import type { ClientApiCapability } from "@fleet-console/infra/http/client-ports";
import { serverReached } from "./board.js";

export async function post<T>(api: ClientApiCapability, path: string, body: unknown): Promise<T> {
  let response: Response;
  try { response = await api.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  catch (error) {
    const failure = error as { name?: unknown; status?: unknown; body?: { error?: unknown; details?: unknown } } | null;
    const code = failure?.body?.error;
    const result = failure?.name === "ApiError" && typeof failure.status === "number" && typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
      ? Object.assign(new Error(code), { status: failure.status, details: failure.body?.details }) : error;
    // 이동 전 보드 요청 helper와 같은 연결 증거다. 네트워크·인가·일시 거절은 게이트를 풀지 않는다.
    const status = typeof result === "object" && result !== null ? (result as { status?: unknown }).status : undefined;
    if (typeof status === "number" && status !== 401 && status !== 408 && status !== 429 && status < 500) serverReached();
    throw result;
  }
  const payload = await response.json().catch(() => null) as (T & { error?: string; details?: unknown }) | null;
  if (!response.ok) throw Object.assign(new Error(payload?.error ?? `http_${response.status}`), { status: response.status, details: payload?.details });
  serverReached();
  return payload as T;
}
