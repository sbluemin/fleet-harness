import { describe, expect, it } from "vitest";

import { formatCommitTime, refBadges, splitCommitSubject } from "../client/repository-parsers.js";
import type { LogCommitEntry } from "../server/types.js";

function makeEntry(overrides: Partial<LogCommitEntry> = {}): LogCommitEntry {
  return {
    shortHash: "abc1234",
    fullHash: "abc1234def5678abc1234def5678abc1234def56",
    subject: "feat: add something",
    authorName: "Author Name",
    relTime: "3 days ago",
    authorAt: 1_700_000_000,
    refs: [],
    parents: ["parent1234"],
    onHead: true,
    hasBody: false,
    ...overrides,
  };
}

describe("formatCommitTime", () => {
  const now = new Date(2026, 6, 10, 15, 30, 0);

  it("오늘 작성한 커밋을 시각과 함께 표시한다", () => {
    expect(formatCommitTime(new Date(2026, 6, 10, 9, 5, 0).getTime() / 1000, now)).toBe("Today 09:05");
  });

  it("어제 작성한 커밋을 시각과 함께 표시한다", () => {
    expect(formatCommitTime(new Date(2026, 6, 9, 21, 45, 0).getTime() / 1000, now)).toBe("Yesterday 21:45");
  });

  it("오래된 커밋은 날짜를 표시한다", () => {
    expect(formatCommitTime(new Date(2026, 5, 1, 9, 0, 0).getTime() / 1000, now)).toBe("2026-06-01");
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

  it("--decorate=full의 'tag: refs/tags/v1.0.0' 형식도 태그명만 남긴다", () => {
    const badges = refBadges(makeEntry({ refs: ["tag: refs/tags/v1.0.0"] }));
    expect(badges).toEqual([{ label: "v1.0.0", kind: "tag" }]);
  });

  it("'refs/remotes/origin/HEAD' 심볼릭 ref는 배지를 만들지 않는다", () => {
    expect(refBadges(makeEntry({ refs: ["refs/remotes/origin/HEAD"] }))).toEqual([]);
  });

  it("'refs/heads/main' 형식 ref를 branch 배지로 분류하고 접두사를 제거한다", () => {
    const badges = refBadges(makeEntry({ refs: ["refs/heads/main"] }));
    expect(badges).toHaveLength(1);
    expect(badges[0]).toEqual({ label: "main", kind: "branch" });
  });

  it("'refs/remotes/origin/main' 형식 ref를 remote 배지로 분류한다", () => {
    const badges = refBadges(makeEntry({ refs: ["refs/remotes/origin/main"] }));
    expect(badges).toEqual([{ label: "origin/main", kind: "remote" }]);
  });

  it("full decoration의 HEAD 접두는 로컬 branch 배지로 분류한다", () => {
    const badges = refBadges(makeEntry({ refs: ["HEAD -> refs/heads/main"] }));
    expect(badges).toEqual([{ label: "main", kind: "branch" }]);
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

describe("splitCommitSubject", () => {
  it("Conventional Commit 접두를 본문에서 떼어낸다", () => {
    expect(splitCommitSubject("feat(fleet-console): open console sessions"))
      .toEqual({ prefix: "feat(fleet-console):", rest: "open console sessions" });
    expect(splitCommitSubject("fix: gate WebSocket upgrades")).toEqual({ prefix: "fix:", rest: "gate WebSocket upgrades" });
  });

  it("breaking change 표식(!)을 접두에 포함한다", () => {
    expect(splitCommitSubject("feat!: retire the Classic launch kind")).toEqual({ prefix: "feat!:", rest: "retire the Classic launch kind" });
    expect(splitCommitSubject("feat(fleet-cli)!: rebuild fleet")).toEqual({ prefix: "feat(fleet-cli)!:", rest: "rebuild fleet" });
  });

  it("규약을 따르지 않는 제목은 접두 없이 그대로 돌려준다", () => {
    for (const subject of ["Merge branch 'canary'", "", "wip"]) {
      expect(splitCommitSubject(subject)).toEqual({ prefix: null, rest: subject });
    }
  });

  it("콜론 뒤 공백을 요구해 URL 스킴을 접두로 오인하지 않는다", () => {
    expect(splitCommitSubject("https://example.com/x is broken"))
      .toEqual({ prefix: null, rest: "https://example.com/x is broken" });
  });
});
