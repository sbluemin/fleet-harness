/**
 * Deterministic risk derivation over a single quota window.
 *
 * A used percentage cannot say on its own whether an allowance is in trouble:
 * 44% spent reads as healthy the day before a reset and dire the day after one
 * opened. What separates those two readings is the window's clock, so every
 * consumer that wants a verdict has to pair the two figures and pick its own
 * thresholds. When each does that privately they drift apart, and the same pool
 * ends up calm on one surface and critical on another.
 *
 * This module is the one place that pairing happens. It takes the facts a
 * provider stated plus the instant the reading was taken, and returns the
 * judgements that follow from them — nothing about which model to pick, which
 * stays with whoever is choosing.
 *
 * A derived field is omitted whenever its inputs cannot support it. Absence
 * here means "could not tell", never "safe".
 */

const MS_PER_HOUR = 3_600_000;
const CADENCE_SESSION_MAX_MS = 20 * MS_PER_HOUR;
const CADENCE_DAILY_MAX_MS = 3 * 24 * MS_PER_HOUR;
const CADENCE_WEEKLY_MAX_MS = 20 * 24 * MS_PER_HOUR;

/**
 * A window younger than this has spent too little of its clock for a pace ratio
 * to mean anything — one early call against 5% of a week reads as a 20x burn.
 */
const MIN_ELAPSED_FRACTION = 0.05;
const PACE_CRITICAL = 1.5;
const PACE_ELEVATED = 1.1;
const USED_CRITICAL_PERCENT = 95;
const USED_ELEVATED_PERCENT = 80;

export type QuotaCadence = "session" | "daily" | "weekly" | "monthly";
export type QuotaWindowPressure = "ok" | "elevated" | "critical";

/** The facts a risk verdict is derived from; a superset of them is fine. */
export interface QuotaWindowRiskInput {
  readonly usedPercent: number;
  readonly resetsAt?: number;
  readonly period?: {
    readonly durationMs: number;
    readonly startsAt?: number;
  };
}

export interface QuotaWindowRisk {
  /** Normalized reset-length class; window ids like `cycle` do not name one. */
  readonly cadence?: QuotaCadence;
  /**
   * How much of the window's clock has run, 0–1. The companion to
   * `usedPercent`: the two together are what makes a spend rate legible, and a
   * surface that draws one without the other is drawing half the reading.
   */
  readonly elapsedFraction?: number;
  /**
   * (used fraction) ÷ (elapsed fraction). Above 1.0 the window is being spent
   * faster than its clock refills it. Omitted while the window is too young for
   * the ratio to mean anything.
   */
  readonly paceRatio?: number;
  /** Linear projection of when the window empties; present only when that lands before the reset. */
  readonly projectedExhaustionAt?: number;
  /** Half the window length: the average lockout bought by draining this pool now. */
  readonly recoveryHalfLifeMs?: number;
  /** The verdict on this window's state. It describes the window, never a choice. */
  readonly pressure: QuotaWindowPressure;
}

export function quotaWindowCadence(durationMs: number): QuotaCadence {
  if (durationMs <= CADENCE_SESSION_MAX_MS) return "session";
  if (durationMs <= CADENCE_DAILY_MAX_MS) return "daily";
  if (durationMs <= CADENCE_WEEKLY_MAX_MS) return "weekly";
  return "monthly";
}

function windowPressure(usedPercent: number, paceRatio: number | undefined): QuotaWindowPressure {
  if (usedPercent >= USED_CRITICAL_PERCENT || (paceRatio !== undefined && paceRatio >= PACE_CRITICAL)) {
    return "critical";
  }
  if (usedPercent >= USED_ELEVATED_PERCENT || (paceRatio !== undefined && paceRatio >= PACE_ELEVATED)) {
    return "elevated";
  }
  return "ok";
}

/**
 * `at` is the instant the reading was taken, not the current wall clock.
 * Summaries are cached, so measuring elapsed time against `now` would put a
 * later denominator under an earlier numerator and let pace drift downward on
 * its own while nothing was spent.
 */
export function deriveQuotaWindowRisk(window: QuotaWindowRiskInput, at: number): QuotaWindowRisk {
  const durationMs = window.period?.durationMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    // No clock to compare against, so the percent band is the whole verdict.
    return { pressure: windowPressure(window.usedPercent, undefined) };
  }
  const startsAt = window.period?.startsAt
    ?? (window.resetsAt !== undefined && window.resetsAt > durationMs ? window.resetsAt - durationMs : undefined);
  const resetBoundary = window.resetsAt ?? (startsAt !== undefined ? startsAt + durationMs : undefined);
  // A reading taken past the boundary belongs to a cycle that already closed;
  // its percent says nothing about the cycle now running.
  const stale = resetBoundary !== undefined && at > resetBoundary;
  let elapsedFraction: number | undefined;
  let paceRatio: number | undefined;
  let projectedExhaustionAt: number | undefined;
  if (startsAt !== undefined && resetBoundary !== undefined && !stale && at > startsAt) {
    const elapsed = Math.min(1, (at - startsAt) / durationMs);
    elapsedFraction = Math.round(elapsed * 100) / 100;
    if (elapsed >= MIN_ELAPSED_FRACTION) {
      const used = Math.min(1, Math.max(0, window.usedPercent / 100));
      paceRatio = Math.round((used / elapsed) * 100) / 100;
      // An already-drained pool has nothing left to forecast: the extrapolation
      // would return the reading's own instant and state a past event as a
      // prediction. `usedPercent` and the pressure verdict already say it.
      if (used > 0 && used < 1) {
        // Linear extrapolation of the average burn so far. Carried only when it
        // lands strictly before the reset — absence states "lasts to reset".
        const exhaustionAt = startsAt + Math.round((at - startsAt) / used);
        if (exhaustionAt < resetBoundary) projectedExhaustionAt = exhaustionAt;
      }
    }
  }
  return {
    cadence: quotaWindowCadence(durationMs),
    ...(elapsedFraction !== undefined ? { elapsedFraction } : {}),
    ...(paceRatio !== undefined ? { paceRatio } : {}),
    ...(projectedExhaustionAt !== undefined ? { projectedExhaustionAt } : {}),
    recoveryHalfLifeMs: Math.round(durationMs / 2),
    pressure: windowPressure(window.usedPercent, paceRatio),
  };
}
