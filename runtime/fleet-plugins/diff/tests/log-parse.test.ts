import { describe, expect, it } from "vitest";

import { formatRelTime, refBadges } from "../client/log-parse.js";
import type { LogCommitEntry } from "../server/types.js";

function makeEntry(overrides: Partial<LogCommitEntry> = {}): LogCommitEntry {
  return {
    shortHash: "abc1234",
    fullHash: "abc1234def5678abc1234def5678abc1234def56",
    subject: "feat: add something",
    authorName: "Author Name",
    relTime: "3 days ago",
    refs: [],
    parents: ["parent1234"],
    additions: 10,
    deletions: 2,
    ...overrides,
  };
}

describe("formatRelTime", () => {
  it("서버 응답의 relTime을 그대로 반환한다", () => {
    const entry = makeEntry({ relTime: "5 hours ago" });
    expect(formatRelTime(entry)).toBe("5 hours ago");
  });
});

describe("refBadges", () => {
  it("refs가 없으면 빈 배열을 반환한다", () => {
    expect(refBadges(makeEntry({ refs: [] }))).toEqual([]);
  });

  it("HEAD를 head 종류 배지로 분류한다", () => {
    const badges = refBadges(makeEntry({ refs: ["HEAD"] }));
    expect(badges).toHaveLength(1);
    expect(badges[0]).toEqual({ label: "HEAD", kind: "head" });
  });

  it("'tag: v1.0.0' 형식 ref를 tag 배지로 분류하고 'tag: ' 접두사를 제거한다", () => {
    const badges = refBadges(makeEntry({ refs: ["tag: v1.0.0"] }));
    expect(badges).toHaveLength(1);
    expect(badges[0]).toEqual({ label: "v1.0.0", kind: "tag" });
  });

  it("'refs/heads/main' 형식 ref를 branch 배지로 분류하고 접두사를 제거한다", () => {
    const badges = refBadges(makeEntry({ refs: ["refs/heads/main"] }));
    expect(badges).toHaveLength(1);
    expect(badges[0]).toEqual({ label: "main", kind: "branch" });
  });

  it("'refs/worktrees/' 접두사 ref를 worktree 배지로 분류하고 접두사를 제거한다", () => {
    const badges = refBadges(makeEntry({ refs: ["refs/worktrees/my-wt"] }));
    expect(badges).toHaveLength(1);
    expect(badges[0]).toEqual({ label: "my-wt", kind: "worktree" });
  });

  it("알 수 없는 ref는 branch 배지로 처리한다", () => {
    const badges = refBadges(makeEntry({ refs: ["origin/main"] }));
    expect(badges).toHaveLength(1);
    expect(badges[0]?.kind).toBe("branch");
  });

  it("HEAD + branch + tag 혼합 ref를 모두 분류한다", () => {
    const badges = refBadges(makeEntry({ refs: ["HEAD", "refs/heads/main", "tag: v2.0"] }));
    expect(badges).toHaveLength(3);
    expect(badges[0]?.kind).toBe("head");
    expect(badges[1]?.kind).toBe("branch");
    expect(badges[2]?.kind).toBe("tag");
  });
});
