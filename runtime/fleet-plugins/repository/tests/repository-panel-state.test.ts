import { describe, expect, it } from "vitest";
import { aggregateWip, shouldShowWip } from "../client/history-panel.js";
import { parseWorktrees } from "../server/refs.js";

describe("Repository panel state contracts", () => {
  it("aggregates WIP and hides it for text or ref filters", () => {
    const wip = aggregateWip([{ path: "a", status: "M", additions: 3, deletions: 1 }, { path: "b", status: "A", additions: 2, deletions: 0 }]);
    expect(wip).toEqual({ files: 2, additions: 5, deletions: 1 });
    expect(shouldShowWip(wip, "", null)).toBe(true);
    expect(shouldShowWip(wip, "find", null)).toBe(false);
    expect(shouldShowWip(wip, "", "refs/heads/main")).toBe(false);
  });

  it("renders browser-safe worktree names and current marker without paths", () => {
    expect(parseWorktrees("worktree /private/repo\nHEAD 123\nbranch refs/heads/main\n\nworktree /private/other\nHEAD 456\n", "main")).toEqual([{ name: "repo", branch: "main", current: true }, { name: "other", branch: null, current: false }]);
  });
});
