import { describe, expect, it } from "vitest";

import { filterDiffFiles } from "../client/changed-files.js";
import { filterHistoryCommits, isInspectorDismissKey } from "../client/history-panel.js";
import type { DiffFileEntry, LogCommitEntry } from "../server/types.js";

// ─── constants ───────────────────────────────────────────────────────────────

const FILES: readonly DiffFileEntry[] = [
  { path: "src/FleetPanel.tsx", status: "M", additions: 4, deletions: 1 },
  { path: "docs/release-notes.md", status: "A", additions: 8, deletions: 0 },
];

const COMMITS: readonly LogCommitEntry[] = [
  {
    shortHash: "AbC1234",
    fullHash: "AbC1234def5678abc1234def5678abc1234def56",
    subject: "Add Fleet filter",
    authorName: "Ada Lovelace",
    relTime: "1 hour ago",
    authorAt: 1_700_000_000,
    refs: ["HEAD -> refs/heads/main", "tag: v1.2.3"],
    parents: [],
    onHead: true,
  },
  {
    shortHash: "def5678",
    fullHash: "def5678fedcba9876543210fedcba9876543210f",
    subject: "Repair graph",
    authorName: "Grace Hopper",
    relTime: "2 hours ago",
    authorAt: 1_700_000_001,
    refs: ["refs/remotes/origin/topic"],
    parents: [],
    onHead: true,
  },
];

// ─── functions ───────────────────────────────────────────────────────────────

describe("filterDiffFiles", () => {
  it("matches complete paths without case sensitivity", () => {
    expect(filterDiffFiles(FILES, "FLEETPANEL")).toEqual([FILES[0]]);
    expect(filterDiffFiles(FILES, "src/")).toEqual([FILES[0]]);
  });

  it("returns no items for an unmatched filter without mutating the selection source", () => {
    const selected = FILES[0]!;

    expect(filterDiffFiles(FILES, "missing")).toEqual([]);
    expect(selected.path).toBe("src/FleetPanel.tsx");
    expect(FILES).toHaveLength(2);
  });
});

describe("filterHistoryCommits", () => {
  it("matches subjects and authors without case sensitivity", () => {
    expect(filterHistoryCommits(COMMITS, "fleet")).toEqual([COMMITS[0]]);
    expect(filterHistoryCommits(COMMITS, "HOPPER")).toEqual([COMMITS[1]]);
  });

  it("matches both hash forms and ref badge labels", () => {
    expect(filterHistoryCommits(COMMITS, "abc1234def")).toEqual([COMMITS[0]]);
    expect(filterHistoryCommits(COMMITS, "v1.2")).toEqual([COMMITS[0]]);
    expect(filterHistoryCommits(COMMITS, "origin/topic")).toEqual([COMMITS[1]]);
  });

  it("returns no items for an unmatched filter without changing a selected commit", () => {
    const selected = COMMITS[0]!;

    expect(filterHistoryCommits(COMMITS, "missing")).toEqual([]);
    expect(selected.fullHash).toBe(COMMITS[0]?.fullHash);
  });
});

describe("inspector dismissal", () => {
  it("recognizes only Escape as the scoped inspector dismiss key", () => {
    expect(isInspectorDismissKey("Escape")).toBe(true);
    expect(isInspectorDismissKey("Enter")).toBe(false);
  });
});
