import { describe, expect, it } from "vitest";

import { parseLogOutput, parseWorktreePorcelain } from "../server/log.js";

describe("parseLogOutput", () => {
  it("%at author time을 정수로 파싱하고 full decorations를 보존한다", () => {
    const output = "\x1e0123456789abcdef\x000123456\x00subject\x00Author\x002 hours ago\x001720000000\x00HEAD -> refs/heads/main, refs/remotes/origin/main, tag: v1.2.3\x00parent-a parent-b";
    expect(parseLogOutput(output)).toEqual([{
      fullHash: "0123456789abcdef",
      shortHash: "0123456",
      subject: "subject",
      authorName: "Author",
      relTime: "2 hours ago",
      authorAt: 1_720_000_000,
      refs: ["HEAD -> refs/heads/main", "refs/remotes/origin/main", "tag: v1.2.3"],
      parents: ["parent-a", "parent-b"],
    }]);
  });
});

describe("parseWorktreePorcelain", () => {
  it("current checkout과 linked worktree branch를 porcelain 출력만으로 병합한다", () => {
    const output = [
      "worktree /repo",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo-topic",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "branch refs/heads/topic",
      "",
      "worktree /repo-detached",
      "HEAD cccccccccccccccccccccccccccccccccccccccc",
      "detached",
      "",
    ].join("\n");

    expect(parseWorktreePorcelain(output, "/repo")).toEqual([
      { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", branch: "main", worktreePath: "/repo", isCurrent: true },
      { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", branch: "topic", worktreePath: "/repo-topic", isCurrent: false },
      { sha: "cccccccccccccccccccccccccccccccccccccccc", branch: null, worktreePath: "/repo-detached", isCurrent: false },
    ]);
  });
});
