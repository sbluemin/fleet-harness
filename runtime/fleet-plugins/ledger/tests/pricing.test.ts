import { describe, expect, it } from "vitest";

import { applyGatewayPricing } from "../server/pricing.js";
import type { TokscaleModelEntry } from "../server/types.js";

function entry(overrides: Partial<TokscaleModelEntry> = {}): TokscaleModelEntry {
  return {
    sessionId: "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103",
    modelId: "claude-gateway--xai--grok-4.6",
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 0,
    costUsd: 0,
    messages: 1,
    ...overrides,
  };
}

describe("static Gateway pricing", () => {
  it("recalculates a tokscale-normalized Gateway alias from its catalog OpenRouter rates", () => {
    expect(applyGatewayPricing(entry({ modelId: "claude-gateway--xai--grok-4-6" })).costUsd).toBe(8.5);
  });

  it("uses the base model rate for a tokscale-normalized Fast service variant", () => {
    const priced = applyGatewayPricing(entry({
      modelId: "claude-gateway--codex--gpt-5-6-sol-fast",
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    }));
    expect(priced.costUsd).toBe(41.75);
  });

  it("replaces an upstream fuzzy-match cost instead of trusting a positive value", () => {
    const priced = applyGatewayPricing(entry({
      modelId: "claude-gateway--kimi--k3",
      costUsd: 999,
    }));
    expect(priced.costUsd).toBe(18.3);
  });

  it("prices a historical Gateway alias even when it is absent from the routing catalog", () => {
    const priced = applyGatewayPricing(entry({
      modelId: "claude-gateway--cursor--gpt-5-6-sol",
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
    }));
    expect(priced.costUsd).toBe(5);
  });

  it("preserves tokscale cost when OpenRouter has no static registry entry", () => {
    const original = entry({
      modelId: "claude-gateway--cursor--auto",
      costUsd: 12.5,
    });
    expect(applyGatewayPricing(original)).toBe(original);
  });

  it("does not reprice native Claude rows", () => {
    const original = entry({ modelId: "claude-opus-5", costUsd: 7 });
    expect(applyGatewayPricing(original)).toBe(original);
  });
});
