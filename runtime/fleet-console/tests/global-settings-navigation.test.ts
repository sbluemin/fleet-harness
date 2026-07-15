import { describe, expect, it } from "vitest";

describe("Global Settings Carrier navigation", () => {
  it("keeps the Terminal Carrier composite ID as the supported deep-link target", () => {
    const target = new URLSearchParams("section=terminal%3Acarriers").get("section");
    expect(target).toBe("terminal:carriers");
  });
});
