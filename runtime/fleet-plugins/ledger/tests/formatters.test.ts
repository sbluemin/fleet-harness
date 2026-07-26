import { describe, expect, it } from "vitest";

import {
  costValueTier,
  formatCost,
  formatCostParts,
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
