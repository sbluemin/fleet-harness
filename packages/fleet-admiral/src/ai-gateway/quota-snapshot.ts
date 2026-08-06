/**
 * Untrusted DTO → loadout quota snapshot validator.
 *
 * The quota plugin shapes the summary it serves, but this boundary never trusts
 * a wire value it did not validate: the loadout derives cadence and pace from
 * these windows, so a malformed provenance or an oversized duration would leak
 * into those derivations. The allowed vocabularies and the 400-day duration cap
 * mirror the quota contract.
 */

import type { GatewayQuotaSnapshot } from "./model-loadout.js";

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

export function parseGatewayQuotaSnapshot(value: unknown): GatewayQuotaSnapshot | undefined {
  const providers = record(record(value)?.providers);
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
