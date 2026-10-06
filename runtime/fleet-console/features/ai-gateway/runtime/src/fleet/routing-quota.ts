import type { GatewayProviderQuota, GatewayQuotaWindow } from "./quota-snapshot.js";

import { QUOTA_CACHE_TTL_MS } from "../quota/service.js";

// 공유 캐시와 비동기 갱신 여유 1분. 오래된 성공값은 나이를 표시한 채 보존한다.
const MAX_OBSERVATION_AGE_MS = QUOTA_CACHE_TTL_MS + 60_000;

export interface RoutingQuota {
  readonly observation: "fresh" | "partial" | "stale" | "unknown";
  readonly ageSeconds?: number;
  readonly remainingPercent?: number;
  readonly sustainableHeadroom?: number;
  /** 추가 소비가 없을 때 병목 잔여량이 처음으로 개선되는 시점. */
  readonly recovery?: { readonly inSeconds: number; readonly remainingPercent: number };
}

/** 집계 풀은 빼되, 모델별 풀과 동시에 적용되는 공급자 공통 제한은 함께 보존한다. */
export function bindingQuotaWindows(quota: GatewayProviderQuota | undefined, scope?: string): readonly GatewayQuotaWindow[] {
  return (quota?.windows ?? []).filter(window => window.isAggregate !== true
    && (scope === undefined || window.scope === undefined || window.scope === scope));
}

/** 원자료는 그대로 두고 판단 모델에만 병목을 보존한 무차원 여유를 제공한다. */
export function normalizeRoutingQuota(quota: GatewayProviderQuota | undefined, scope: string | undefined, now: number): RoutingQuota {
  const at = quota?.fetchedAt;
  if (at === undefined || !Number.isFinite(at) || at < 0 || at > now) return { observation: "unknown" };
  const ageSeconds = Math.floor((now - at) / 1_000);
  const stale = quota?.status === "stale" || now - at > MAX_OBSERVATION_AGE_MS;
  const windows = bindingQuotaWindows(quota, scope);
  if ((quota?.status !== "ok" && quota?.status !== "stale") || windows.length === 0) return { observation: "unknown", ageSeconds };
  // 다른 풀이나 공통 제한만으로 해당 모델 풀의 잔여량을 추정하지 않는다.
  const missingScope = scope !== undefined && !windows.some(window => window.scope === scope);
  const facts = windows.map(window => {
    const validUsage = Number.isFinite(window.usedPercent) && window.usedPercent >= 0;
    const remaining = validUsage ? Math.max(0, 1 - window.usedPercent / 100) : undefined;
    const duration = window.period?.durationMs;
    const reset = window.resetsAt ?? (window.period?.startsAt !== undefined && duration !== undefined
      ? window.period.startsAt + duration : undefined);
    const validReset = reset !== undefined && Number.isFinite(reset);
    const expired = validReset && reset <= now;
    const validClock = validReset && duration !== undefined && Number.isFinite(duration) && duration > 0
      && reset > at && reset - at <= duration;
    return { remaining, reset: validReset ? reset : undefined, expired,
      // 관측 이후 시간이 흐른 것만으로 소비 여유가 커지지 않도록 관측 시각을 사용한다.
      headroom: remaining !== undefined && validClock ? remaining / ((reset - at) / duration) : undefined };
  });
  // 리셋을 넘긴 옛 사용량을 0% 사용으로 자동 갱신하지 않는다. 새 관측이 필요하다.
  if (facts.some(fact => fact.expired)) return { observation: "stale", ageSeconds };
  const complete = !missingScope && facts.every(fact => fact.remaining !== undefined && fact.headroom !== undefined);
  const remainingKnown = !missingScope && facts.every(fact => fact.remaining !== undefined);
  const remaining = remainingKnown ? Math.min(...facts.map(fact => fact.remaining!)) : undefined;
  const headroom = complete ? Math.min(...facts.map(fact => fact.headroom!)) : undefined;
  let recovery: RoutingQuota["recovery"];
  if (complete && remaining !== undefined) {
    // 첫 리셋이 다른 병목을 해소하지 않으면 건너뛴다. 이미 리셋된 풀은 추가 사용 없이 100%다.
    for (const reset of [...new Set(facts.map(fact => fact.reset!))].sort((a, b) => a - b)) {
      const after = Math.min(...facts.map(fact => fact.reset! <= reset ? 1 : fact.remaining!));
      if (after > remaining) {
        recovery = { inSeconds: Math.ceil((reset - now) / 1_000), remainingPercent: round(after * 100) };
        break;
      }
    }
  }
  return {
    observation: stale ? "stale" : complete ? "fresh" : "partial", ageSeconds,
    ...(remaining === undefined ? {} : { remainingPercent: round(remaining * 100) }),
    ...(headroom === undefined ? {} : { sustainableHeadroom: round(Math.min(headroom, 100)) }),
    ...(recovery === undefined ? {} : { recovery }),
  };
}

// 아주 작은 양수 잔여량을 0(소진)으로 바꾸지 않는다.
function round(value: number): number { return Number(value.toPrecision(6)); }
