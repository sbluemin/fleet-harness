import { afterEach, describe, expect, it, vi } from "vitest";

import { readRepositorySource, readScanDepth } from "../client/rail-panel.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Repository source preference", () => {
  it("reads a valid persisted source", () => {
    vi.stubGlobal("localStorage", { getItem: () => "history" });
    expect(readRepositorySource()).toBe("history");
  });

  it("keeps the repository context source", () => {
    vi.stubGlobal("localStorage", { getItem: () => "repositories" });
    expect(readRepositorySource()).toBe("repositories");
  });

  it("keeps the worktree context source", () => {
    vi.stubGlobal("localStorage", { getItem: () => "worktrees" });
    expect(readRepositorySource()).toBe("worktrees");
  });

  it("keeps the compare source", () => {
    vi.stubGlobal("localStorage", { getItem: () => "compare" });
    expect(readRepositorySource()).toBe("compare");
  });

  it("reads a valid persisted scan depth", () => {
    vi.stubGlobal("localStorage", { getItem: () => "6" });
    expect(readScanDepth()).toBe(6);
  });

  it.each(["0", "9", "3.5", "abc", "", null])("falls back to depth 3 for an invalid persisted scan depth", (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(readScanDepth()).toBe(3);
  });

  it.each(["diff", "unknown", "", null])( "falls back to Changes for an invalid persisted source", (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(readRepositorySource()).toBe("changes");
  });
});
