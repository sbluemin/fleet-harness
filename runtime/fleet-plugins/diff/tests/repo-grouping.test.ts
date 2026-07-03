import { describe, expect, it } from "vitest";

import { groupRepos, relativeToParent } from "../client/repo-grouping.js";
import type { RepoEntry } from "../server/types.js";

// 클라이언트 순수 로직 — DOM/React 없이 Node.js 환경에서 단위 테스트 가능.

describe("groupRepos", () => {
  it("worktreeOf 없는 항목만 있으면 그룹이 1:1로 생성된다", () => {
    const repos: RepoEntry[] = [
      { relPath: "", name: "root", branch: "main" },
      { relPath: "sub", name: "sub", branch: "dev" },
    ];
    const { groups, topLevelCount } = groupRepos(repos);
    expect(topLevelCount).toBe(2);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.worktrees).toHaveLength(0);
    expect(groups[1]!.worktrees).toHaveLength(0);
  });

  it("worktreeOf가 있는 항목은 부모 그룹의 worktrees 배열에 들어간다", () => {
    const repos: RepoEntry[] = [
      { relPath: "main", name: "main", branch: "main" },
      { relPath: "main/.wt/feat", name: ".wt/feat", branch: "feat", isWorktree: true, worktreeOf: "main" },
    ];
    const { groups, topLevelCount } = groupRepos(repos);
    // topLevelCount는 worktreeOf 없는 항목 수
    expect(topLevelCount).toBe(1);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.repo.relPath).toBe("main");
    expect(groups[0]!.worktrees).toHaveLength(1);
    expect(groups[0]!.worktrees[0]!.relPath).toBe("main/.wt/feat");
  });

  it("여러 워크트리가 동일 부모에 묶인다", () => {
    const repos: RepoEntry[] = [
      { relPath: "repo", name: "repo", branch: "main" },
      { relPath: "repo/.wt/a", name: "a", branch: "a", isWorktree: true, worktreeOf: "repo" },
      { relPath: "repo/.wt/b", name: "b", branch: "b", isWorktree: true, worktreeOf: "repo" },
      { relPath: "repo/.wt/c", name: "c", branch: "c", isWorktree: true, worktreeOf: "repo" },
    ];
    const { groups, topLevelCount } = groupRepos(repos);
    expect(topLevelCount).toBe(1);
    expect(groups[0]!.worktrees).toHaveLength(3);
  });

  it("고아 워크트리(isWorktree=true, worktreeOf 없음)는 단독 최상위 그룹으로 유지된다", () => {
    const repos: RepoEntry[] = [
      { relPath: "orphan", name: "orphan", branch: "feat", isWorktree: true },
    ];
    const { groups, topLevelCount } = groupRepos(repos);
    expect(topLevelCount).toBe(1);
    expect(groups[0]!.repo.isWorktree).toBe(true);
    expect(groups[0]!.worktrees).toHaveLength(0);
  });

  it("빈 배열이면 groups=[], topLevelCount=0을 반환한다", () => {
    const { groups, topLevelCount } = groupRepos([]);
    expect(groups).toHaveLength(0);
    expect(topLevelCount).toBe(0);
  });

  it("복수 부모+복수 워크트리 혼합 시나리오", () => {
    const repos: RepoEntry[] = [
      { relPath: "a", name: "a", branch: "main" },
      { relPath: "b", name: "b", branch: "main" },
      { relPath: "a/.wt/x", name: "x", branch: "x", isWorktree: true, worktreeOf: "a" },
      { relPath: "b/.wt/y", name: "y", branch: "y", isWorktree: true, worktreeOf: "b" },
      { relPath: "standalone", name: "standalone", branch: "main" },
    ];
    const { groups, topLevelCount } = groupRepos(repos);
    expect(topLevelCount).toBe(3); // a, b, standalone (워크트리 제외)
    expect(groups).toHaveLength(3);
    const groupA = groups.find((g) => g.repo.relPath === "a")!;
    expect(groupA.worktrees).toHaveLength(1);
    expect(groupA.worktrees[0]!.relPath).toBe("a/.wt/x");
  });
});

describe("relativeToParent", () => {
  it("부모 접두사를 제거해 상대경로를 반환한다", () => {
    expect(relativeToParent("repos/main/.worktrees/feat", "repos/main")).toBe(".worktrees/feat");
  });

  it("parentRelPath가 빈 문자열이면 childRelPath 전체를 반환한다", () => {
    expect(relativeToParent("some/path", "")).toBe("some/path");
  });

  it("경로가 부모 접두사로 시작하지 않으면 childRelPath(정규화)를 반환한다", () => {
    expect(relativeToParent("other/path", "repos/main")).toBe("other/path");
  });

  it("Windows 역슬래시 경로도 정규화해 처리한다", () => {
    expect(relativeToParent("repos\\main\\.wt\\feat", "repos\\main")).toBe(".wt/feat");
  });

  it("theater root가 부모(relPath='')인 워크트리 경로도 처리한다", () => {
    expect(relativeToParent(".worktrees/hotfix", "")).toBe(".worktrees/hotfix");
  });
});
