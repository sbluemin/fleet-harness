import { describe, expect, it } from "vitest";
import { aggregateWip, shouldShowWip } from "../client/history-panel.js";
import { parseRefItems } from "../server/refs.js";

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
      branches: parseRefItems("refs/heads/main\0main\n", "refs/heads/main"),
      tags: parseRefItems("refs/tags/main\0main\n", "refs/heads/main"),
    }).toEqual({
      branches: [{ label: "main", ref: "refs/heads/main", current: true }],
      tags: [{ label: "main", ref: "refs/tags/main", current: false }],
    });
  });

  it("uses the canonical current ref when an ambiguous short label includes its namespace", () => {
    expect(parseRefItems("refs/heads/collision\0heads/collision\n", "refs/heads/collision")).toEqual([
      { label: "heads/collision", ref: "refs/heads/collision", current: true },
    ]);
  });
});
