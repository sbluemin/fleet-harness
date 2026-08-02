import type { GatewayQuotaSnapshot } from "@dotobokuri/fleet-admiral";

// 쿼터는 quota 플러그인이 소유하고, 플러그인 서버 모듈 간 직접 import는 금지다.
// 콘솔 SDK에도 플러그인 간 서비스 조회 지점이 없으므로, 이미 공개 계약인 그 플러그인의
// HTTP 라우트를 콘솔 내부에서 호출한다. 게이트웨이 base URL을 콘솔 origin에서 얻는 것과
// 같은 경로다.
const QUOTA_SUMMARY_PATH = "/plugins/quota/summary";
// 요약은 네 프로바이더를 모두 기다린 뒤에야 응답한다. 각 프로바이더 요청은 10초까지
// 버티고 일부는 엔드포인트를 두 번 순차 호출하므로, 캐시가 비어 있는 첫 조회의 최악
// 대기는 20초에 이른다. 그보다 짧게 끊으면 이미 성공한 프로바이더의 결과까지 함께
// 버려져 전부 unsupported로 보고된다. 이 값은 그 최악 대기를 넘겨야 한다.
const QUOTA_REQUEST_TIMEOUT_MS = 25_000;
const QUOTA_MAX_RESPONSE_BYTES = 65_536;

/**
 * Read the Console's own quota panel as the loadout's allowance source.
 *
 * Returns `undefined` on any failure so the roster degrades to
 * `status: "unsupported"` — which states the gap — instead of implying room.
 */
export async function readConsoleQuotaSnapshot(
  origin: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayQuotaSnapshot | undefined> {
  if (!origin) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTA_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${origin}${QUOTA_SUMMARY_PATH}`, {
      method: "GET",
      headers: { Origin: origin, Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    if (text.length > QUOTA_MAX_RESPONSE_BYTES) return undefined;
    return toQuotaSnapshot(JSON.parse(text));
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function toQuotaSnapshot(payload: unknown): GatewayQuotaSnapshot | undefined {
  const providers = record(record(payload)?.providers);
  if (!providers) return undefined;
  const snapshot: Record<string, {
    status: string;
    windows?: Array<{ id: string; scope?: string; usedPercent: number; resetsAt?: number }>;
    fetchedAt?: number;
  }> = {};
  for (const [id, value] of Object.entries(providers)) {
    const provider = record(value);
    if (!provider || typeof provider.status !== "string") continue;
    const windows = Array.isArray(provider.windows)
      ? provider.windows.flatMap((entry) => {
          const window = record(entry);
          if (!window || typeof window.id !== "string" || typeof window.usedPercent !== "number") return [];
          return [{
            id: window.id,
            ...(typeof window.scope === "string" ? { scope: window.scope } : {}),
            usedPercent: window.usedPercent,
            ...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt } : {}),
          }];
        })
      : undefined;
    snapshot[id] = {
      status: provider.status,
      ...(windows && windows.length > 0 ? { windows } : {}),
      ...(typeof provider.fetchedAt === "number" ? { fetchedAt: provider.fetchedAt } : {}),
    };
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}
