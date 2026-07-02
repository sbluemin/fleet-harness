import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitExecutorError, runGit } from "../server/git-executor.js";
import { REPOS_CAP, resolveRepoBranch, scanRepos } from "../server/repos.js";
import type { RepoEntry } from "../server/types.js";

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
    const repos: RepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 3, repos);
    expect(repos).toHaveLength(1);
    expect(repos[0]!.relPath).toBe("");
  });

  it("중첩 저장소를 재귀로 탐지한다", async () => {
    const inner = path.join(tmpDir, "sub");
    await mkdirp(inner);
    await initGitRepo(inner);
    const realTheater = await fs.realpath(tmpDir);
    const repos: RepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 3, repos);
    expect(repos.some((r) => r.relPath === "sub")).toBe(true);
  });

  it(".git 파일(워크트리)도 저장소로 탐지한다", async () => {
    const inner = path.join(tmpDir, "wt");
    await mkdirp(inner);
    // 워크트리는 .git이 파일로 존재함
    await fs.writeFile(path.join(inner, ".git"), "gitdir: /some/path/.git/worktrees/wt");
    const realTheater = await fs.realpath(tmpDir);
    const repos: RepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 3, repos);
    // branch 해석은 git repo가 아니라 "unknown"이 되지만 저장소로 등록돼야 한다
    expect(repos.some((r) => r.relPath === "wt")).toBe(true);
  });

  it("maxDepth=1 이면 depth 2 이상 저장소를 탐지하지 않는다", async () => {
    const d1 = path.join(tmpDir, "a");
    const d2 = path.join(tmpDir, "a", "b");
    await mkdirp(d2);
    await initGitRepo(d2);
    const realTheater = await fs.realpath(tmpDir);
    const repos: RepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 1, repos);
    expect(repos.some((r) => r.relPath === path.join("a", "b"))).toBe(false);
    void d1; // 미사용 경고 억제
  });

  it("maxDepth=2 이면 depth 2 저장소를 탐지한다", async () => {
    const d2 = path.join(tmpDir, "a", "b");
    await mkdirp(d2);
    await initGitRepo(d2);
    const realTheater = await fs.realpath(tmpDir);
    const repos: RepoEntry[] = [];
    await scanRepos(tmpDir, realTheater, tmpDir, 0, 2, repos);
    expect(repos.some((r) => r.relPath.endsWith("b"))).toBe(true);
  });

  it("node_modules 내부는 순회하지 않는다", async () => {
    const nm = path.join(tmpDir, "node_modules", "pkg");
    await mkdirp(nm);
    await initGitRepo(nm);
    const realTheater = await fs.realpath(tmpDir);
    const repos: RepoEntry[] = [];
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
    const repos: RepoEntry[] = [];
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
      const repos: RepoEntry[] = [];
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
