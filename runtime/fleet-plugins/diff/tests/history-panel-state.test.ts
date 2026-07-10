import { describe, expect, it } from "vitest";

import { pathContextKey } from "../client/context-key.js";
import { findDetachedCheckout } from "../client/history-panel.js";
import type { LogCommitEntry, WorktreeCheckout } from "../server/types.js";

// ─── constants ───────────────────────────────────────────────────────────────

const COMMIT: LogCommitEntry = {
  shortHash: "abc1234",
  fullHash: "abc1234def5678abc1234def5678abc1234def56",
  subject: "test commit",
  authorName: "Author",
  relTime: "1 hour ago",
  authorAt: 1_700_000_000,
  refs: [],
  parents: [],
  onHead: true,
};

// ─── functions ───────────────────────────────────────────────────────────────

describe("History checkout markers", () => {
  it("detached checkout은 branch badge 없이 SHA로 찾는다", () => {
    const checkouts: WorktreeCheckout[] = [
      { sha: COMMIT.fullHash, branch: null, isCurrent: true },
      { sha: "other", branch: "topic", isCurrent: false },
    ];

    expect(findDetachedCheckout(COMMIT, checkouts)).toEqual(checkouts[0]);
  });
});

describe("History context identity", () => {
  it("uses Theater and relative path together as the remount identity", () => {
    const root = pathContextKey("theater-a", null);

    expect(pathContextKey("theater-a", null)).toBe(root);
    expect(pathContextKey("theater-a", "src")).not.toBe(root);
    expect(pathContextKey("theater-b", null)).not.toBe(root);
  });
});
