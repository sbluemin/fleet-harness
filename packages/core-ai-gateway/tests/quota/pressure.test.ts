import { describe, expect, it } from "vitest";

import { deriveQuotaWindowRisk, quotaWindowCadence } from "../../src/quota/pressure.js";
import { createQuotaService } from "../../src/quota/service.js";

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const START = 1_800_000_000_000;

function weekly(usedPercent: number, elapsedFraction: number) {
  return deriveQuotaWindowRisk(
    { usedPercent, resetsAt: START + WEEK, period: { durationMs: WEEK, startsAt: START } },
    START + WEEK * elapsedFraction,
  );
}

describe("quota window risk", () => {
  // A percent band alone cannot separate these two: the same 44% is a fifth of
  // the way into the cycle in one and nearly all of it in the other.
  it("separates a burn rate from a percentage", () => {
    const burning = weekly(44, 0.2);
    const coasting = weekly(44, 0.9);
    expect(burning.pressure).toBe("critical");
    expect(burning.paceRatio).toBe(2.2);
    expect(coasting.pressure).toBe("ok");
    expect(coasting.paceRatio).toBe(0.49);
  });

  it("reports elapsed fraction so a consumer never redoes epoch arithmetic", () => {
    expect(weekly(44, 0.2).elapsedFraction).toBe(0.2);
    expect(weekly(0, 0.75).elapsedFraction).toBe(0.75);
  });

  it("projects exhaustion only when it lands before the reset", () => {
    const burning = weekly(44, 0.2);
    expect(burning.projectedExhaustionAt).toBeDefined();
    expect(burning.projectedExhaustionAt ?? Number.POSITIVE_INFINITY).toBeLessThan(START + WEEK);
    // Absence has to mean "lasts to reset", so a coasting window must omit it
    // rather than carry a timestamp past the boundary.
    expect(weekly(44, 0.9)).not.toHaveProperty("projectedExhaustionAt");
  });

  // A drained pool's extrapolation returns the reading's own instant, which a
  // surface renders as "runs out in 0m" — a past event dressed as a forecast.
  it("stops forecasting once the pool is already drained", () => {
    const drained = weekly(100, 0.5);
    expect(drained.pressure).toBe("critical");
    expect(drained).not.toHaveProperty("projectedExhaustionAt");
  });

  it("withholds pace while the window is too young for it to mean anything", () => {
    const young = weekly(3, 0.01);
    expect(young).not.toHaveProperty("paceRatio");
    expect(young.pressure).toBe("ok");
  });

  it("falls back to the percent band when no clock is known", () => {
    const risk = deriveQuotaWindowRisk({ usedPercent: 96 }, START);
    expect(risk).toEqual({ pressure: "critical" });
  });

  it("ignores a reading taken after the cycle it measured had closed", () => {
    const risk = deriveQuotaWindowRisk(
      { usedPercent: 90, resetsAt: START + WEEK, period: { durationMs: WEEK, startsAt: START } },
      START + WEEK + HOUR,
    );
    expect(risk).not.toHaveProperty("paceRatio");
    expect(risk).not.toHaveProperty("elapsedFraction");
  });

  it("classifies cadence from the window length", () => {
    expect(quotaWindowCadence(5 * HOUR)).toBe("session");
    expect(quotaWindowCadence(24 * HOUR)).toBe("daily");
    expect(quotaWindowCadence(WEEK)).toBe("weekly");
    expect(quotaWindowCadence(31 * 24 * HOUR)).toBe("monthly");
  });
});

describe("quota summary risk", () => {
  it("attaches a verdict to every served window", async () => {
    const service = createQuotaService({
      isClaudeConnected: async () => true,
      isCursorConnected: async () => false,
      fetchClaude: async () => ({
        status: "ok",
        fetchedAt: START + WEEK * 0.2,
        windows: [{ id: "weekly", usedPercent: 44, resetsAt: START + WEEK, period: { durationMs: WEEK, durationBasis: "catalog", startsAt: START, startsAtBasis: "derived" } }],
      }),
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchCursor: async () => ({ status: "signed_out" }),
      fetchKimi: async () => ({ status: "signed_out" }),
    });
    const window = (await service.getSummary()).providers.claude.windows?.[0];
    expect(window?.risk).toMatchObject({ pressure: "critical", paceRatio: 2.2, elapsedFraction: 0.2 });
  });

  // The summary is cached for minutes. Timing the reading against the clock at
  // read time would put a later denominator under an earlier numerator and let
  // pace decay on its own while nothing was spent.
  it("times the verdict from the reading, not from the moment it is served", async () => {
    let now = START + WEEK * 0.2;
    const service = createQuotaService({
      now: () => now,
      isClaudeConnected: async () => true,
      isCursorConnected: async () => false,
      fetchClaude: async () => ({
        status: "ok",
        fetchedAt: START + WEEK * 0.2,
        windows: [{ id: "weekly", usedPercent: 44, resetsAt: START + WEEK, period: { durationMs: WEEK, durationBasis: "catalog", startsAt: START, startsAtBasis: "derived" } }],
      }),
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchCursor: async () => ({ status: "signed_out" }),
      fetchKimi: async () => ({ status: "signed_out" }),
    });
    const first = (await service.getSummary()).providers.claude.windows?.[0]?.risk;
    now += WEEK * 0.5;
    const second = (await service.getSummary()).providers.claude.windows?.[0]?.risk;
    expect(second).toEqual(first);
  });
});
