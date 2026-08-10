import { describe, expect, it } from "vitest";

import type { QuotaWindow } from "@dotobokuri/core-ai-gateway";

import {
  beginRequestGeneration,
  elapsedMarkPercent,
  EXPIRED_KEY,
  formatCountdown,
  formatPace,
  isLatestRequestGeneration,
  meterSeverity,
  NO_SUBSCRIPTION_KEY,
  projectedSpan,
  SIGNED_OUT_KEY,
} from "../client/rail-panel.js";
import { QUOTA_MESSAGES } from "../client/i18n/messages.js";

describe("quota countdown", () => {
  it("formats day, hour, and minute windows", () => {
    const now = 1_000_000;
    expect(formatCountdown(now + 4 * 86_400_000 + 7 * 3_600_000, now)).toBe("4d 7h");
    expect(formatCountdown(now + 4 * 3_600_000 + 23 * 60_000, now)).toBe("4h 23m");
    expect(formatCountdown(now + 12 * 60_000, now)).toBe("12m");
  });

  it("prevents an older in-flight request from committing after a newer request starts", () => {
    const generation = { current: 0 };
    const staleRequest = beginRequestGeneration(generation);
    const newestRequest = beginRequestGeneration(generation);
    expect(isLatestRequestGeneration(generation, staleRequest)).toBe(false);
    expect(isLatestRequestGeneration(generation, newestRequest)).toBe(true);
  });
});

describe("meter risk", () => {
  function window(usedPercent: number, risk?: QuotaWindow["risk"]): QuotaWindow {
    return { id: "weekly", usedPercent, ...(risk ? { risk } : {}) };
  }

  // The defect this replaced: a pool 44% spent a fifth of the way into its week
  // is on track to run dry days early, and the gateway says so — but a local
  // 70/90 percent band painted it calm, so the panel and the roster a model
  // reads disagreed about the same allowance.
  it("takes its severity from the gateway verdict, not from the percentage", () => {
    expect(meterSeverity(window(44, { pressure: "critical", paceRatio: 2.11 }))).toBe("critical");
    expect(meterSeverity(window(92, { pressure: "ok", paceRatio: 0.4 }))).toBe("normal");
    expect(meterSeverity(window(85, { pressure: "elevated", paceRatio: 1.2 }))).toBe("warning");
  });

  it("falls back to percent bands only when no verdict arrived", () => {
    expect(meterSeverity(window(95))).toBe("critical");
    expect(meterSeverity(window(75))).toBe("warning");
    expect(meterSeverity(window(10))).toBe("normal");
  });

  it("spans the projection from what is spent to the end of the bar", () => {
    expect(projectedSpan(window(44, { pressure: "critical", projectedExhaustionAt: 5 })))
      .toEqual({ left: 44, width: 56 });
  });

  it("draws no projection when the window lasts to its reset", () => {
    expect(projectedSpan(window(44, { pressure: "ok" }))).toBeNull();
    // A drained pool has no remaining stretch to project into.
    expect(projectedSpan(window(100, { pressure: "critical", projectedExhaustionAt: 5 }))).toBeNull();
  });

  it("places the elapsed mark only when the window's clock is known", () => {
    expect(elapsedMarkPercent(window(44, { pressure: "critical", elapsedFraction: 0.21 }))).toBe(21);
    expect(elapsedMarkPercent(window(44, { pressure: "ok" }))).toBeNull();
  });

  it("states pace to one decimal", () => {
    expect(formatPace(2.11)).toBe("2.1");
    expect(formatPace(1)).toBe("1");
  });
});

describe("provider status copy", () => {
  // 상태 문구는 해당 공급자에서 무엇을 해야 하는지 지시한다. 한 공급자의 안내가 다른
  // 공급자 카드에 뜨면 사용자는 엉뚱한 CLI나 설정 화면으로 보내진다.
  it("names its own provider in every provider-specific message", () => {
    const en = QUOTA_MESSAGES.en;
    const expectedMention: Readonly<Record<string, string>> = {
      claude: "Claude",
      codex: "Codex",
      cursor: "Cursor",
      kimi: "Kimi",
      opencode: "OpenCode Go",
    };
    for (const map of [SIGNED_OUT_KEY, EXPIRED_KEY]) {
      for (const [provider, key] of Object.entries(map)) {
        expect(en[key], `${provider} → ${key}`).toContain(expectedMention[provider] ?? provider);
      }
    }
    // Kimi가 공용 문구를 타면 "No active Cursor subscription." 이 뜬다.
    expect(en[NO_SUBSCRIPTION_KEY.kimi]).toContain("Kimi");
    expect(en[NO_SUBSCRIPTION_KEY.kimi]).not.toContain("Cursor");
    expect(en[NO_SUBSCRIPTION_KEY.cursor]).toContain("Cursor");
  });
});
