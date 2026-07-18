import { describe, expect, it } from "vitest";
import { aggregateWip, shouldShowWip } from "../client/history-panel.js";
import { parseRefItems, parseWorktrees } from "../server/refs.js";

describe("Repository panel state contracts", () => {
  it("aggregates WIP exclusively from the supplied changed-files snapshot", () => {
    const snapshot = [{ path: "a", status: "M" as const, additions: 3, deletions: 1 }, { path: "b", status: "A" as const, additions: 2, deletions: 0 }];
    const wip = aggregateWip(snapshot);
    expect(wip).toEqual({ files: 2, additions: 5, deletions: 1 });
    expect(aggregateWip([])).toEqual({ files: 0, additions: 0, deletions: 0 });
    expect(shouldShowWip(wip, "", null)).toBe(true);
    expect(shouldShowWip(wip, "find", null)).toBe(false);
    expect(shouldShowWip(wip, "", "refs/heads/main")).toBe(false);
  });

  it("keeps canonical full names distinct when heads and tags share a label", () => {
    expect({
      branches: parseRefItems("refs/heads/main\0main\n", "main"),
      tags: parseRefItems("refs/tags/main\0main\n", "main"),
    }).toEqual({
      branches: [{ label: "main", ref: "refs/heads/main", current: true }],
      tags: [{ label: "main", ref: "refs/tags/main", current: false }],
    });
  });

  it("renders browser-safe worktree names and current marker without paths", async () => {
    expect(await parseWorktrees("worktree /private/repo\nHEAD 123\nbranch refs/heads/main\n\nworktree /private/other\nHEAD 456\n", "/private/repo")).toEqual([{ name: "repo", branch: "main", current: true }, { name: "other", branch: null, current: false }]);
  });
});
