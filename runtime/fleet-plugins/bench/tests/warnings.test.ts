import { describe, it, expect } from "vitest";

import { detectEditingKeywords } from "../server/warnings.js";

describe("detectEditingKeywords", () => {
  it("returns empty array for read-only prompts", () => {
    expect(detectEditingKeywords("List all files in the project")).toEqual([]);
    expect(detectEditingKeywords("Explain the function")).toEqual([]);
  });

  it("detects editing keywords", () => {
    const warnings = detectEditingKeywords("Please write a function that will edit the file");
    expect(warnings.length).toBeGreaterThan(0);
    const terms = warnings.map((w) => w.term);
    expect(terms).toContain("write");
    expect(terms).toContain("edit");
    expect(warnings.every((w) => w.code === "editing_keyword")).toBe(true);
  });

  it("is case-insensitive and deduplicates", () => {
    const warnings = detectEditingKeywords("Write write WRITE");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.term).toBe("write");
  });

  it("detects multiple different keywords", () => {
    const warnings = detectEditingKeywords("delete and rename the files");
    const terms = warnings.map((w) => w.term);
    expect(terms).toContain("delete");
    expect(terms).toContain("rename");
  });
});
