import { describe, expect, it } from "vitest";

import { estimateTokens } from "../src/gateway.js";

describe("token estimate", () => {
  it("uses the conservative model ratio for code-oriented model families", () => {
    const text = "x".repeat(140);

    expect(estimateTokens(text, "glm-5.2-high")).toBe(40);
    expect(estimateTokens(text, "composer-2.5-fast")).toBe(35);
  });

  it("raises the estimate for CJK-heavy prompts", () => {
    const text = "한국어 컨텍스트 집계 ".repeat(80);

    expect(estimateTokens(text, "composer-2.5-fast")).toBe(Math.ceil(text.length / 2.5));
  });
});
