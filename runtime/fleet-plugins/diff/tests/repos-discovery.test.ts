import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitExecutorError, runGit } from "../server/git-executor.js";
import { REPOS_CAP, resolveRepoBranch, resolveWorktreeParents, scanRepos } from "../server/repos.js";
import type { RawRepoEntry } from "../server/repos.js";

// 실제 파일 시스템 + 실제 git 명령어를 사용하는 화이트박스 테스트.

async function initGitRepo(dir: string): Promise<void> {
  await runGit(["init"], { cwd: dir });
  await runGit(["config", "user.email", "test@test.com"], { cwd: dir });
  await runGit(["config", "user.name", "Test"], { cwd: dir });
}

async function mkdirp(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

describe("repos 디스커버리", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repos-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("theater root 자체가 git 저장소면 relPath '' 로 등록된다", async () => {
    await initGitRepo(tmpDir);
    const realTheater = await fs.realpath(tmpDir);
    const repos: RawRepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 3, repos);
    expect(repos).toHaveLength(1);
    expect(repos[0]!.relPath).toBe("");
  });

  it("중첩 저장소를 재귀로 탐지한다", async () => {
    const inner = path.join(tmpDir, "sub");
    await mkdirp(inner);
    await initGitRepo(inner);
    const realTheater = await fs.realpath(tmpDir);
    const repos: RawRepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 3, repos);
    expect(repos.some((r) => r.relPath === "sub")).toBe(true);
  });

  it(".git 파일(링크드 워크트리)을 isWorktree:true로 분류한다", async () => {
    const inner = path.join(tmpDir, "wt");
    await mkdirp(inner);
    // 링크드 워크트리는 .git이 파일로 존재하며 /worktrees/ 포인터를 가짐
    await fs.writeFile(path.join(inner, ".git"), "gitdir: /some/path/.git/worktrees/wt");
    const realTheater = await fs.realpath(tmpDir);
    const repos: RawRepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 3, repos);
    const wtEntry = repos.find((r) => r.relPath === "wt");
    expect(wtEntry).toBeDefined();
    // 워크트리로 분류돼야 한다
    expect(wtEntry?.isWorktree).toBe(true);
    // 부모(/some/path)가 theater 밖이므로 _wtParentAbs는 설정되지만 worktreeOf는 없다
    expect(wtEntry?.worktreeOf).toBeUndefined();
  });

  it("gitdir 포인터 → theater 내 부모가 있으면 worktreeOf를 도출한다", async () => {
    // 부모 저장소(더미 .git 디렉터리)
    const parentDir = path.join(tmpDir, "main");
    await mkdirp(path.join(parentDir, ".git"));

    // 워크트리: .git 파일이 부모의 /worktrees/ 경로를 가리킴
    const wtDir = path.join(tmpDir, "feature");
    await mkdirp(wtDir);
    await fs.writeFile(
      path.join(wtDir, ".git"),
      `gitdir: ${parentDir}/.git/worktrees/feature`,
    );

    const realTheater = await fs.realpath(tmpDir);
    const raw: RawRepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 3, raw);

    const resolved = resolveWorktreeParents(raw, realTheater);

    const featureEntry = resolved.find((r) => r.relPath === "feature");
    expect(featureEntry?.isWorktree).toBe(true);
    expect(featureEntry?.worktreeOf).toBe("main");

    const mainEntry = resolved.find((r) => r.relPath === "main");
    expect(mainEntry?.isWorktree).toBeUndefined();
    expect(mainEntry?.worktreeOf).toBeUndefined();
  });

  it("/modules/ 경로를 가진 .git 파일(서브모듈)은 워크트리로 분류하지 않는다", async () => {
    const inner = path.join(tmpDir, "submodule");
    await mkdirp(inner);
    // 서브모듈의 .git 파일은 /modules/ 경로를 가짐
    await fs.writeFile(
      path.join(inner, ".git"),
      "gitdir: /parent/.git/modules/submodule",
    );
    const realTheater = await fs.realpath(tmpDir);
    const repos: RawRepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 3, repos);
    const smEntry = repos.find((r) => r.relPath === "submodule");
    // 서브모듈은 독립 저장소로 등록돼야 한다
    expect(smEntry).toBeDefined();
    expect(smEntry?.isWorktree).toBeUndefined();
    expect(smEntry?.worktreeOf).toBeUndefined();
  });

  it("부모가 theater 밖인 고아 워크트리는 isWorktree:true이지만 worktreeOf 없이 top-level 유지", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repos-outside-"));
    try {
      const wtDir = path.join(tmpDir, "orphan-wt");
      await mkdirp(wtDir);
      // 부모가 theater 밖
      await fs.writeFile(
        path.join(wtDir, ".git"),
        `gitdir: ${outside}/.git/worktrees/orphan-wt`,
      );
      const realTheater = await fs.realpath(tmpDir);
      const raw: RawRepoEntry[] = [];
      await scanRepos(tmpDir, realTheater, tmpDir, 0, 3, raw);
      const resolved = resolveWorktreeParents(raw, realTheater);
      const orphan = resolved.find((r) => r.relPath === "orphan-wt");
      expect(orphan).toBeDefined();
      expect(orphan?.isWorktree).toBe(true);
      expect(orphan?.worktreeOf).toBeUndefined();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("상대 gitdir 경로도 워크트리로 올바르게 resolve한다", async () => {
    // 부모 저장소
    const parentDir = path.join(tmpDir, "repo");
    await mkdirp(path.join(parentDir, ".git"));

    // 워크트리: 상대경로로 gitdir 포인터 작성
    const wtDir = path.join(tmpDir, "repo", "linked-wt");
    await mkdirp(wtDir);
    // 상대경로: wtDir 기준으로 ../../repo/.git/worktrees/linked-wt
    // = path.relative(wtDir, parentDir + "/.git/worktrees/linked-wt")
    const relGitdir = path.relative(wtDir, path.join(parentDir, ".git", "worktrees", "linked-wt"));
    await fs.writeFile(path.join(wtDir, ".git"), `gitdir: ${relGitdir}`);

    const realTheater = await fs.realpath(tmpDir);
    const raw: RawRepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 5, raw);
    const resolved = resolveWorktreeParents(raw, realTheater);

    const wtEntry = resolved.find((r) => r.relPath === path.join("repo", "linked-wt"));
    expect(wtEntry?.isWorktree).toBe(true);
    expect(wtEntry?.worktreeOf).toBe("repo");
  });

  it("maxDepth=1 이면 depth 2 이상 저장소를 탐지하지 않는다", async () => {
    const d1 = path.join(tmpDir, "a");
    const d2 = path.join(tmpDir, "a", "b");
    await mkdirp(d2);
    await initGitRepo(d2);
    const realTheater = await fs.realpath(tmpDir);
    const repos: RawRepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 1, repos);
    expect(repos.some((r) => r.relPath === path.join("a", "b"))).toBe(false);
    void d1; // 미사용 경고 억제
  });

  it("maxDepth=2 이면 depth 2 저장소를 탐지한다", async () => {
    const d2 = path.join(tmpDir, "a", "b");
    await mkdirp(d2);
    await initGitRepo(d2);
    const realTheater = await fs.realpath(tmpDir);
    const repos: RawRepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 2, repos);
    expect(repos.some((r) => r.relPath.endsWith("b"))).toBe(true);
  });

  it("node_modules 내부는 순회하지 않는다", async () => {
    const nm = path.join(tmpDir, "node_modules", "pkg");
    await mkdirp(nm);
    await initGitRepo(nm);
    const realTheater = await fs.realpath(tmpDir);
    const repos: RawRepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 5, repos);
    expect(repos.some((r) => r.relPath.includes("node_modules"))).toBe(false);
  });

  it("개수 cap 초과 시 truncated=true를 반환한다", async () => {
    // cap=1로 설정, 저장소 2개 생성
    for (const name of ["r1", "r2"]) {
      const d = path.join(tmpDir, name);
      await mkdirp(d);
      await initGitRepo(d);
    }
    const realTheater = await fs.realpath(tmpDir);
    const repos: RawRepoEntry[] = [];
    const truncated = await scanRepos(tmpDir, realTheater, tmpDir, 0, 3, repos, 1);
    expect(truncated).toBe(true);
    expect(repos.length).toBeLessThanOrEqual(1);
  });

  it("REPOS_CAP이 양수 정수임을 확인한다", () => {
    expect(typeof REPOS_CAP).toBe("number");
    expect(REPOS_CAP).toBeGreaterThan(0);
    expect(Number.isInteger(REPOS_CAP)).toBe(true);
  });

  it("theater 밖으로 나가는 심링크 디렉터리는 스킵된다", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repos-outside-"));
    try {
      await initGitRepo(outside);
      // theater 안에 심링크 생성
      const link = path.join(tmpDir, "symlink-to-outside");
      await fs.symlink(outside, link);
      const realTheater = await fs.realpath(tmpDir);
      const repos: RawRepoEntry[] = [];
      await scanRepos(tmpDir, realTheater, tmpDir, 0, 3, repos);
      // 심링크를 통해 외부 저장소가 등록되어서는 안 된다
      expect(repos.some((r) => r.relPath === "symlink-to-outside")).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("detached HEAD 저장소는 브랜치 대신 short SHA를 반환한다", async () => {
    const inner = path.join(tmpDir, "detached");
    await mkdirp(inner);
    await initGitRepo(inner);
    // 커밋 생성 후 detached HEAD 상태로 전환
    await fs.writeFile(path.join(inner, "a.txt"), "a");
    await runGit(["add", "."], { cwd: inner });
    await runGit(["commit", "-m", "init"], { cwd: inner });
    const sha = (await runGit(["rev-parse", "HEAD"], { cwd: inner })).stdout.trim();
    await runGit(["checkout", "--detach", sha], { cwd: inner });
    const branch = await resolveRepoBranch(inner);
    // SHA 형식 (7자 이상 hex)
    expect(branch).toMatch(/^[0-9a-f]{4,40}$/);
  });

  it("git 리포가 아닌 디렉터리에서 runGit 실행 시 no_git_repo 에러를 던진다", async () => {
    await expect(
      runGit(["diff"], { cwd: tmpDir }),
    ).rejects.toSatisfy((err: unknown) =>
      err instanceof GitExecutorError && err.code === "no_git_repo",
    );
  });
});
