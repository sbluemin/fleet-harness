import { describe, expect, it } from "vitest";

import {
  costValueTier,
  formatCost,
  formatCostParts,
  formatShare,
  formatTokenParts,
  formatTokens,
  lowerValueTier,
  safePercent,
  tokenValueTier,
} from "../client/formatters.js";

describe("Ledger formatters", () => {
  it("promotes rounded token values to the next unit", () => {
    expect(formatTokens(999_999)).toBe("1.0M");
    expect(formatTokens(999_999_999)).toBe("1.00B");
    expect(formatTokens(26_300_000)).toBe("26.3M");
    expect(formatTokens(1_600_000_000)).toBe("1.60B");
    expect(formatTokens(984_000)).toBe("984k");
  });

  it("formats USD to two decimals and handles a zero denominator", () => {
    expect(formatCost(12.344)).toBe("$12.34");
    expect(safePercent(8, 0)).toBe(0);
  });

  it("splits currency symbols and token units from the numeric body", () => {
    expect(formatCostParts(12.34)).toEqual({ prefix: "$", number: "12.34", suffix: "" });
    expect(formatTokenParts(26_300_000)).toEqual({ prefix: "", number: "26.3", suffix: "M" });
  });

  it("assigns cost brightness tiers at the exact boundaries", () => {
    expect(costValueTier(0.99)).toBe("tertiary");
    expect(costValueTier(1)).toBe("secondary");
    expect(costValueTier(99.99)).toBe("secondary");
    expect(costValueTier(100)).toBe("primary");
  });

  it("never lets share rounding contradict the total", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(-1)).toBe("0%");
    expect(formatShare(Number.NaN)).toBe("0%");
    expect(formatShare(0.04)).toBe("<0.1%");
    expect(formatShare(0.1)).toBe("0.1%");
    expect(formatShare(9.94)).toBe("9.9%");
    expect(formatShare(10)).toBe("10%");
    expect(formatShare(33.76)).toBe("34%");
    // 정수 반올림은 99.5~99.9를 100%로 올린다 — 전부가 아닌 몫은 어느 값에서도 100%로 읽히면 안 된다.
    expect(formatShare(99.5)).toBe("99.5%");
    expect(formatShare(99.9)).toBe("99.9%");
    expect(formatShare(99.94)).toBe(">99.9%");
    expect(formatShare(100)).toBe("100%");
    expect(formatShare(120)).toBe("100%");
  });

  it("keeps share labels monotonic across the whole range", () => {
    const samples = Array.from({ length: 2_001 }, (_, index) => index * 0.05);
    const rank = (share: string): number => (
      share === "0%" ? -1
        : share === "<0.1%" ? 0
          : share === ">99.9%" ? 1_000
            : share === "100%" ? 1_001
              : Number.parseFloat(share)
    );
    const ranks = samples.map((value) => rank(formatShare(value)));
    expect(ranks.every((value, index) => index === 0 || value >= ranks[index - 1]!)).toBe(true);
    expect(samples.filter((value) => value < 100 && formatShare(value) === "100%")).toEqual([]);
    expect(samples.filter((value) => value > 0 && formatShare(value) === "0%")).toEqual([]);
  });

  it("assigns token brightness tiers and lowers symbol tiers", () => {
    expect(tokenValueTier(999_999)).toBe("tertiary");
    expect(tokenValueTier(1_000_000)).toBe("secondary");
    expect(tokenValueTier(99_999_999)).toBe("secondary");
    expect(tokenValueTier(100_000_000)).toBe("primary");
    expect(lowerValueTier("primary")).toBe("secondary");
    expect(lowerValueTier("secondary")).toBe("tertiary");
    expect(lowerValueTier("tertiary")).toBe("tertiary");
  });
});
