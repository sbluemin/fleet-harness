import { afterEach, describe, expect, it, vi } from "vitest";

import { readRepositoryRel, saveRepositoryRel } from "../client/rail-panel.js";
import { clearSelectedFile, getSelectedFile, setSelectedFile } from "../client/repository-view-store.js";
import type { RepoCandidate, WorktreeCandidate } from "../server/types.js";

const repos: readonly RepoCandidate[] = [
  { relPath: "", name: "theater", branch: "main", kind: "root" },
];
const worktrees: readonly WorktreeCandidate[] = [
  { relPath: "", name: "theater", branch: "main", current: false },
  { relPath: "worktrees/feature", name: "feature", branch: "feature", current: true },
];

afterEach(() => {
  clearSelectedFile();
  vi.unstubAllGlobals();
});

describe("Repository context persistence", () => {
  it("persists and restores only the selected relPath per Theater", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });

    saveRepositoryRel("theater-1", "worktrees/feature");
    expect(values).toEqual(new Map([["fleet-console.repository.repo.theater-1", "worktrees/feature"]]));
    expect(readRepositoryRel("theater-1", repos, worktrees)).toBe("worktrees/feature");
  });

  it("heals a stale persisted worktree to root and removes the key", () => {
    const removeItem = vi.fn();
    vi.stubGlobal("localStorage", {
      getItem: () => "worktrees/deleted",
      setItem: vi.fn(),
      removeItem,
    });

    expect(readRepositoryRel("theater-1", repos, worktrees)).toBe("");
    expect(removeItem).toHaveBeenCalledWith("fleet-console.repository.repo.theater-1");
  });
});

describe("Selected file repository context keying", () => {
  it("does not expose a selected file across repository contexts", () => {
    const entry = { path: "src/a.ts", status: "M" as const, additions: 1, deletions: 0 };
    setSelectedFile(entry, "theater-1", "worktrees/feature");

    expect(getSelectedFile("theater-1", "worktrees/feature")?.entry).toEqual(entry);
    expect(getSelectedFile("theater-1", "")).toBeNull();
    expect(getSelectedFile("theater-2", "worktrees/feature")).toBeNull();
  });
});
