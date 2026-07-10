import { describe, expect, it } from "vitest";

import { findDetachedCheckout, resetTheaterScopedState } from "../client/history-panel.js";
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

describe("History theater reset", () => {
  it("theater가 null이 되기 전 fetch를 무효화하고 theater 상태를 초기화한다", () => {
    const fetchSeqRef = { current: 7 };
    const calls: string[] = [];

    resetTheaterScopedState(fetchSeqRef, {
      setActiveSubPath: (value) => calls.push(`subPath:${value}`),
      setSelectedCommit: (value) => calls.push(`selected:${String(value)}`),
      setRepos: (value) => calls.push(`repos:${value.length}`),
      setReposLoading: (value) => calls.push(`loading:${value}`),
      setReposTruncated: (value) => calls.push(`truncated:${value}`),
      setMenuOpen: (value) => calls.push(`menu:${value}`),
    });

    expect(fetchSeqRef.current).toBe(8);
    expect(calls).toEqual([
      "subPath:",
      "selected:null",
      "repos:0",
      "loading:false",
      "truncated:false",
      "menu:false",
    ]);
  });
});
