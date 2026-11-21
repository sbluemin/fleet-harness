/**
 * 「더 월드 (The World)」 Theater 발전도 지표 공유 계약.
 *
 * 호스트(Node)와 브라우저 클라이언트가 함께 소비하는 순수 TypeScript 계층이다.
 * 보안 불변식: 원시 파일시스템 절대경로(`path`)는 이 DTO에 절대 포함하지 않는다.
 */

export const THE_WORLD_METRICS_PATH = "/api/v1/the-world/metrics" as const;

export type WorldDevelopmentTier = 0 | 1 | 2 | 3 | 4 | 5;

export type WorldDevelopmentTierCode =
  | "meadow"
  | "camp"
  | "hamlet"
  | "town"
  | "city"
  | "metropolis";

export type WorldTheaterStatus = "available" | "missing" | "unreadable";

export interface WorldTheaterMetrics {
  readonly theaterId: string;
  readonly status: WorldTheaterStatus;
  readonly fileCount: number;
  readonly dirCount: number;
  readonly totalEntries: number;
  readonly truncated: boolean;
  readonly scannedAt: number;
}

export interface WorldMetricsResponse {
  readonly metrics: Readonly<Record<string, WorldTheaterMetrics>>;
  readonly generatedAt: number;
}

export interface WorldDevelopmentProgress {
  readonly tier: WorldDevelopmentTier;
  readonly code: WorldDevelopmentTierCode;
  readonly progress01: number;
  readonly remainingToNext: number;
  readonly nextTierThreshold: number | null;
}

export const WORLD_METRICS_LIMITS = {
  maxEntries: 25_000,
  maxDepth: 12,
  maxDurationMs: 1_500,
  cacheTtlMs: 60_000,
  refreshCooldownMs: 5_000,
  concurrency: 3,
} as const;

/** 각 발전도 티어 진입 최소 엔트리 수 (`totalEntries = fileCount + dirCount`). */
export const WORLD_TIER_THRESHOLDS: readonly [0, 1, 26, 121, 601, 2_501] = [
  0,
  1,
  26,
  121,
  601,
  2_501,
];

export const WORLD_TIER_CODES: readonly [
  "meadow",
  "camp",
  "hamlet",
  "town",
  "city",
  "metropolis",
] = ["meadow", "camp", "hamlet", "town", "city", "metropolis"];

export function computeDevelopmentTier(
  totalEntries: number,
  truncated = false,
): WorldDevelopmentTier {
  if (truncated) return 5;
  const count = Number.isFinite(totalEntries) && totalEntries > 0 ? Math.floor(totalEntries) : 0;
  if (count <= 0) return 0;
  if (count < WORLD_TIER_THRESHOLDS[2]) return 1;
  if (count < WORLD_TIER_THRESHOLDS[3]) return 2;
  if (count < WORLD_TIER_THRESHOLDS[4]) return 3;
  if (count < WORLD_TIER_THRESHOLDS[5]) return 4;
  return 5;
}

export function computeDevelopmentProgress(
  totalEntries: number,
  truncated = false,
): WorldDevelopmentProgress {
  const count = Number.isFinite(totalEntries) && totalEntries > 0 ? Math.floor(totalEntries) : 0;
  const tier = computeDevelopmentTier(count, truncated);
  const code = WORLD_TIER_CODES[tier];

  if (tier === 5) {
    return {
      tier,
      code,
      progress01: 1,
      remainingToNext: 0,
      nextTierThreshold: null,
    };
  }

  const nextThreshold = WORLD_TIER_THRESHOLDS[tier + 1]!;
  if (tier === 0) {
    return {
      tier,
      code,
      progress01: 0,
      remainingToNext: nextThreshold,
      nextTierThreshold: nextThreshold,
    };
  }

  const curThreshold = WORLD_TIER_THRESHOLDS[tier]!;
  const span = Math.max(1, nextThreshold - curThreshold);
  // 로그 보간으로 초반 진행 감각을 자연스럽게 표현한다.
  const progress01 = Math.max(
    0,
    Math.min(1, Math.log1p(Math.max(0, count - curThreshold)) / Math.log1p(span)),
  );
  return {
    tier,
    code,
    progress01,
    remainingToNext: Math.max(0, nextThreshold - count),
    nextTierThreshold: nextThreshold,
  };
}
