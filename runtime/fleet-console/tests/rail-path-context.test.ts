import { describe, expect, it } from "vitest";

import { assertRailPathContext, assertRailPathDirectories, assertRailPathWorktrees } from "../core/client/src/rail/path-context-api.js";

describe("rail path-context API validators", () => {
  it("accepts normalized root, worktree, and directory contexts", () => {
    expect(assertRailPathContext({ kind: "root", relPath: null, label: "Theater" })).toEqual({ kind: "root", relPath: null, label: "Theater" });
    expect(assertRailPathContext({ kind: "worktree", relPath: "worktrees/next", label: "next" }).relPath).toBe("worktrees/next");
    expect(assertRailPathContext({ kind: "directory", relPath: "packages/core", label: "core" }).kind).toBe("directory");
  });

  it("rejects raw paths, traversal, and browser-sensitive fields", () => {
    expect(() => assertRailPathContext({ kind: "directory", relPath: "/private/tmp", label: "tmp" })).toThrow();
    expect(() => assertRailPathContext({ kind: "directory", relPath: "a/../b", label: "b" })).toThrow();
    expect(() => assertRailPathContext({ kind: "directory", relPath: "a", label: "a", cwd: "/private/tmp" })).toThrow();
  });

  it("validates worktree and directory collections without root duplication", () => {
    const worktrees = assertRailPathWorktrees({ isGitRepo: true, worktrees: [{ relPath: "wt", branch: "feat/wt", isCurrent: true }] });
    expect(worktrees.worktrees).toHaveLength(1);
    expect(() => assertRailPathWorktrees({ isGitRepo: true, worktrees: [{ relPath: "", branch: null, isCurrent: true }] })).toThrow();
    expect(assertRailPathDirectories({ directories: [{ relPath: "packages", label: "packages" }] })[0]?.relPath).toBe("packages");
  });
});
