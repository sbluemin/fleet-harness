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

// amounts는 개수 문자열만 통과시킨다. quota 플러그인이 이미 같은 형태로 좁히지만,
// 이 경계는 HTTP 응답을 신뢰하지 않으므로 자체 검증을 유지한다.
const AMOUNT_PATTERN = /^\d{1,15}$/;
// quota 계층의 계약을 그대로 되짚는다: 기간 상한 400일, provenance는 닫힌 어휘.
// 미지의 basis를 통과시키면 하류 파생이 출처 불명의 기간 위에서 수행된다.
const MAX_WINDOW_DURATION_MS = 400 * 24 * 3_600_000;
const DURATION_BASES = new Set(["upstream", "catalog"]);
const START_BASES = new Set(["upstream", "derived"]);

function toWindowPeriod(value: unknown): {
  durationMs: number;
  durationBasis: string;
  startsAt?: number;
  startsAtBasis?: string;
} | undefined {
  const period = record(value);
  if (!period) return undefined;
  const durationMs = period.durationMs;
  const durationBasis = period.durationBasis;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  if (durationMs > MAX_WINDOW_DURATION_MS) return undefined;
  if (typeof durationBasis !== "string" || !DURATION_BASES.has(durationBasis)) return undefined;
  const startsAt = typeof period.startsAt === "number" && Number.isFinite(period.startsAt)
    ? period.startsAt
    : undefined;
  const startsAtBasis = typeof period.startsAtBasis === "string" && START_BASES.has(period.startsAtBasis)
    ? period.startsAtBasis
    : undefined;
  return {
    durationMs,
    durationBasis,
    ...(startsAt !== undefined ? { startsAt } : {}),
    ...(startsAt !== undefined && startsAtBasis !== undefined ? { startsAtBasis } : {}),
  };
}

function toWindowAmounts(value: unknown): { used: string; limit: string } | undefined {
  const amounts = record(value);
  if (!amounts) return undefined;
  const used = amounts.used;
  const limit = amounts.limit;
  if (typeof used !== "string" || typeof limit !== "string") return undefined;
  if (!AMOUNT_PATTERN.test(used) || !AMOUNT_PATTERN.test(limit)) return undefined;
  return { used, limit };
}

export function toQuotaSnapshot(payload: unknown): GatewayQuotaSnapshot | undefined {
  const providers = record(record(payload)?.providers);
  if (!providers) return undefined;
  const snapshot: Record<string, {
    status: string;
    windows?: Array<{
      id: string;
      scope?: string;
      label?: string;
      usedPercent: number;
      resetsAt?: number;
      period?: { durationMs: number; durationBasis: string; startsAt?: number; startsAtBasis?: string };
      isAggregate?: boolean;
      amounts?: { used: string; limit: string };
    }>;
    fetchedAt?: number;
  }> = {};
  for (const [id, value] of Object.entries(providers)) {
    const provider = record(value);
    if (!provider || typeof provider.status !== "string") continue;
    const windows = Array.isArray(provider.windows)
      ? provider.windows.flatMap((entry) => {
          const window = record(entry);
          if (!window || typeof window.id !== "string" || typeof window.usedPercent !== "number") return [];
          const period = toWindowPeriod(window.period);
          const amounts = toWindowAmounts(window.amounts);
          return [{
            id: window.id,
            ...(typeof window.scope === "string" ? { scope: window.scope } : {}),
            ...(typeof window.label === "string" ? { label: window.label } : {}),
            usedPercent: window.usedPercent,
            ...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt } : {}),
            ...(period ? { period } : {}),
            ...(window.isAggregate === true ? { isAggregate: true } : {}),
            ...(amounts ? { amounts } : {}),
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
