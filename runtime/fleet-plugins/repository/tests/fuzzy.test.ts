import { describe, expect, it } from "vitest";

import { fuzzyMatch } from "../client/fuzzy.js";

describe("fuzzyMatch", () => {
  it("greedily matches a subsequence", () => {
    expect(fuzzyMatch("plg", "examples/plugin-demo")).toEqual([4, 5, 12]);
  });

  it("ignores letter casing", () => {
    expect(fuzzyMatch("FH", "fleet-harness")).toEqual([0, 6]);
  });

  it("returns null when the subsequence is absent", () => {
    expect(fuzzyMatch("xyz", "fleet-harness")).toBeNull();
  });

  it("returns no indices for an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual([]);
  });

  it("returns increasing indices whose characters match the query", () => {
    const text = "packages/core-agent";
    const indices = fuzzyMatch("core", text);
    expect(indices).not.toBeNull();
    expect(indices!.every((index, position) => position === 0 || index > indices![position - 1]!)).toBe(true);
    expect(indices!.map((index) => text[index]).join("").toLowerCase()).toBe("core");
  });

  it("returns code-point indices for surrogate pairs", () => {
    expect(fuzzyMatch("😀", "😀repo")).toEqual([0]);
    expect(fuzzyMatch("r", "😀repo")).toEqual([1]);
  });
});
