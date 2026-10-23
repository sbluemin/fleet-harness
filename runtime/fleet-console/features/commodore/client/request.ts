import type { ClientApiCapability } from "@fleet-console/infra/http/client-ports";
import { serverReached } from "./board.js";

const resolutions = new WeakMap<ClientApiCapability, Map<string, Promise<string>>>();

/** Theater 머리에서 UUID를 풀고, 제품 요청에는 UUID만 싣는다. 경로는 브라우저로 오지 않는다. */
export async function postCommodore<T>(api: ClientApiCapability, path: string, body: Record<string, unknown> & { readonly theaterId: string }): Promise<T> {
  let cache = resolutions.get(api);
  if (!cache) { cache = new Map(); resolutions.set(api, cache); }
  let resolving = cache.get(body.theaterId);
  if (!resolving) {
    resolving = post<{ readonly commodoreId: string | null }>(api, "/commodore/resolve", { theaterId: body.theaterId }).then((result) => {
      if (!result.commodoreId) throw new Error("commodore_unavailable");
      return result.commodoreId;
    });
    cache.set(body.theaterId, resolving);
    void resolving.catch(() => { if (cache!.get(body.theaterId) === resolving) cache!.delete(body.theaterId); });
  }
  const commodoreId = await resolving;
  const { theaterId: _theaterId, ...payload } = body;
  return post<T>(api, path, { ...payload, commodoreId });
}

export async function post<T>(api: ClientApiCapability, path: string, body: unknown): Promise<T> {
  let response: Response;
  try { response = await api.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  catch (error) {
    const failure = error as { name?: unknown; status?: unknown; body?: { error?: unknown } } | null;
    const code = failure?.body?.error;
    const result = failure?.name === "ApiError" && typeof failure.status === "number" && typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
      ? Object.assign(new Error(code), { status: failure.status }) : error;
    // 이동 전 보드 요청 helper와 같은 연결 증거다. 네트워크·인가·일시 거절은 게이트를 풀지 않는다.
    const status = typeof result === "object" && result !== null ? (result as { status?: unknown }).status : undefined;
    if (typeof status === "number" && status !== 401 && status !== 408 && status !== 429 && status < 500) serverReached();
    throw result;
  }
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw Object.assign(new Error(payload?.error ?? `http_${response.status}`), { status: response.status });
  serverReached();
  return payload as T;
}
