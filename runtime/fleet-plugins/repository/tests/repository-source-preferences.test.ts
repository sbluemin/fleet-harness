import { afterEach, describe, expect, it, vi } from "vitest";

import { readRepositorySource, readScanDepth } from "../client/rail-panel.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Repository source preference", () => {
  it.each(["history", "changes"])("reads a valid persisted center view", (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(readRepositorySource()).toBe(value);
  });

  it("reads a valid persisted scan depth", () => {
    vi.stubGlobal("localStorage", { getItem: () => "6" });
    expect(readScanDepth()).toBe(6);
  });

  it.each(["0", "9", "3.5", "abc", "", null])("falls back to depth 3 for an invalid persisted scan depth", (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(readScanDepth()).toBe(3);
  });

  // 구 소스 페이지 값(repositories/branches 등)과 은퇴한 compare 뷰는 워크스페이스 중앙 뷰가 아니므로 History로 착지한다.
  it.each(["repositories", "worktrees", "branches", "tags", "stashes", "diff", "compare", "unknown", "", null])("lands legacy or invalid persisted sources on History", (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(readRepositorySource()).toBe("history");
  });
});
