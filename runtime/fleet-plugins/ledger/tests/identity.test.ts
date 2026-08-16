import { describe, expect, it } from "vitest";

import {
  canonicalModelIdentity,
  humanizeBareModel,
  normalizeModelKey,
  parseModelIdentity,
} from "../server/identity.js";

describe("model identity", () => {
  it("attributes a native Claude model to Anthropic", () => {
    expect(parseModelIdentity("claude-opus-5")).toEqual({
      modelId: "claude-opus-5",
      provider: "anthropic",
      bare: "claude-opus-5",
      label: "Claude Opus 5",
    });
  });

  it("extracts each Gateway provider and bare model from its alias", () => {
    expect(parseModelIdentity("claude-gateway--cursor--claude-opus-5")).toEqual({
      modelId: "claude-gateway--cursor--claude-opus-5",
      provider: "cursor",
      bare: "claude-opus-5",
      label: "Claude Opus 5",
    });
    expect(parseModelIdentity("claude-gateway--xai--grok-4.6")).toMatchObject({
      provider: "xai",
      bare: "grok-4.6",
      label: "Grok 4.6",
    });
  });

  it("keeps unknown non-Gateway ids visible without claiming Anthropic", () => {
    expect(parseModelIdentity("gpt-5")).toMatchObject({ provider: "unknown", bare: "gpt-5", label: "GPT 5" });
  });

  it("keeps the same model on different providers distinct", () => {
    expect(normalizeModelKey("claude-opus-5"))
      .not.toBe(normalizeModelKey("claude-gateway--cursor--claude-opus-5"));
  });

  it("joins tokscale variants and Fast tiers only within one provider", () => {
    expect(normalizeModelKey("claude-gateway--codex--gpt-5.6-sol-fast"))
      .toBe(normalizeModelKey("claude-gateway--codex--gpt-5-6-sol"));
    expect(normalizeModelKey("claude-gateway--cursor--gpt-5.6-sol-fast"))
      .not.toBe(normalizeModelKey("claude-gateway--codex--gpt-5-6-sol"));
    expect(canonicalModelIdentity("claude-gateway--cursor--grok-4.6-fast")).toMatchObject({
      bare: "grok-4.6",
      label: "Grok 4.6",
    });
  });

  it("restores tokscale's hyphenated numeric model versions", () => {
    expect(humanizeBareModel("grok-4-6-fast")).toBe("Grok 4.6 Fast");
    expect(humanizeBareModel("claude-opus-4-8")).toBe("Claude Opus 4.8");
    expect(humanizeBareModel("composer-2-5")).toBe("Composer 2.5");
  });

  it("keeps a 1M marker as one suffix", () => {
    expect(humanizeBareModel("claude-fable-5[1m]")).toBe("Claude Fable 5 (1M)");
    expect(humanizeBareModel("claude-opus-5-1m[1m]")).toBe("Claude Opus 5 (1M)");
    expect(humanizeBareModel("claude-opus-5-1m")).toBe("Claude Opus 5 (1M)");
  });
});
