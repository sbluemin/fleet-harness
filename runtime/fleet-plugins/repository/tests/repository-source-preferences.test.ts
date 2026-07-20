import { afterEach, describe, expect, it, vi } from "vitest";

import { readRepositorySource } from "../client/rail-panel.js";

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

  it.each(["diff", "unknown", "", null])( "falls back to Changes for an invalid persisted source", (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(readRepositorySource()).toBe("changes");
  });
});
