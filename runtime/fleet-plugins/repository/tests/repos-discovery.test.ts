import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { runGit } from "../server/git-executor.js";
import { HARD_CAP_DEPTH, NESTED_BRANCH_CAP, REPOS_CAP, handleRepositoryRepos, resolveNestedRepoCandidates, resolveRepoBranch, scanRepos, type ScannedRepo } from "../server/repos.js";
import type { ReposResult } from "../server/types.js";

interface JsonWrite { readonly status: number; readonly payload: unknown }

async function initGitRepo(dir: string, commit = false): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await runGit(["init"], { cwd: dir });
  await runGit(["config", "user.email", "test@test.com"], { cwd: dir });
  await runGit(["config", "user.name", "Test"], { cwd: dir });
  if (commit) {
    await fs.writeFile(path.join(dir, "base.txt"), "base\n");
    await runGit(["add", "."], { cwd: dir });
    await runGit(["commit", "-m", "base"], { cwd: dir });
  }
}

function makeContext(theaterPath: string, body: Record<string, unknown>, writes: JsonWrite[]): FleetPluginServerContext {
  return { host: { http: { readJsonBody: async () => body, writeJson: (_res: unknown, status: number, payload: unknown) => writes.push({ status, payload }) }, security: { isTerminalAuthorized: () => true }, paths: { resolveTheaterPath: () => theaterPath } } } as unknown as FleetPluginServerContext;
}

async function discover(theaterPath: string, body: Record<string, unknown> = { theaterId: "theater" }): Promise<ReposResult> {
  const writes: JsonWrite[] = [];
  await handleRepositoryRepos({ method: "POST" } as never, {} as never, makeContext(theaterPath, body, writes));
  expect(writes).toHaveLength(1);
  expect(writes[0]?.status).toBe(200);
  return writes[0]?.payload as ReposResult;
}

describe("Repository discovery route", () => {
  let theaterPath: string;

  beforeEach(async () => { theaterPath = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-repos-")); });
  afterEach(async () => { await fs.rm(theaterPath, { recursive: true, force: true }); });

  it("discovers the root and nested repositories without linked worktrees", async () => {
    await initGitRepo(theaterPath, true);
    const worktree = path.join(theaterPath, "linked-worktree");
    await runGit(["worktree", "add", "-b", "linked-branch", worktree], { cwd: theaterPath });
    await initGitRepo(path.join(theaterPath, "nested"), true);

    const result = await discover(theaterPath);
    expect(result.repos.map(({ relPath, kind }) => ({ relPath, kind }))).toEqual([
      { relPath: "", kind: "root" },
      { relPath: "nested", kind: "nested" },
    ]);
    expect(result.repos[1]?.branch).not.toBe("");
  });

  it("excludes worktrees outside the Theater", async () => {
    await initGitRepo(theaterPath, true);
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-outside-worktree-"));
    const outsideWorktree = path.join(outsideRoot, "worktree");
    try {
      await runGit(["worktree", "add", "-b", "outside-branch", outsideWorktree], { cwd: theaterPath });
      const result = await discover(theaterPath);
      expect(result.repos).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(outsideWorktree);
    } finally {
      await runGit(["worktree", "remove", "--force", outsideWorktree], { cwd: theaterPath });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("excludes a nested repository whose gitfile points outside the Theater", async () => {
    await initGitRepo(theaterPath, true);
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-outside-gitdir-"));
    await initGitRepo(outsideRoot, true);
    const impostor = path.join(theaterPath, "impostor");
    await fs.mkdir(impostor, { recursive: true });
    await fs.writeFile(path.join(impostor, ".git"), `gitdir: ${path.join(outsideRoot, ".git")}\n`);
    try {
      const result = await discover(theaterPath);
      expect(result.repos.map((repo) => repo.relPath)).toEqual([""]);
      expect(JSON.stringify(result)).not.toContain(outsideRoot);
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("excludes a nested repository whose .git symlink points outside the Theater", async () => {
    await initGitRepo(theaterPath, true);
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-outside-symlink-"));
    await initGitRepo(outsideRoot, true);
    const impostor = path.join(theaterPath, "impostor");
    await fs.mkdir(impostor, { recursive: true });
    await fs.symlink(path.join(outsideRoot, ".git"), path.join(impostor, ".git"));
    try {
      expect((await discover(theaterPath)).repos.map((repo) => repo.relPath)).toEqual([""]);
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("excludes a nested repository whose .git symlink resolves to a gitfile pointing outside", async () => {
    await initGitRepo(theaterPath, true);
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-outside-chain-"));
    await initGitRepo(outsideRoot, true);
    const innerGitfile = path.join(theaterPath, "inner-gitfile");
    await fs.writeFile(innerGitfile, `gitdir: ${path.join(outsideRoot, ".git")}\n`);
    const impostor = path.join(theaterPath, "impostor");
    await fs.mkdir(impostor, { recursive: true });
    await fs.symlink(innerGitfile, path.join(impostor, ".git"));
    try {
      expect((await discover(theaterPath)).repos.map((repo) => repo.relPath)).toEqual([""]);
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("excludes a nested repository whose gitdir commondir points outside the Theater", async () => {
    await initGitRepo(theaterPath, true);
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-outside-common-"));
    await initGitRepo(outsideRoot, true);
    const impostor = path.join(theaterPath, "impostor");
    const impostorGitDir = path.join(impostor, "fake-gitdir");
    await fs.mkdir(impostorGitDir, { recursive: true });
    await fs.writeFile(path.join(impostorGitDir, "commondir"), `${path.join(outsideRoot, ".git")}\n`);
    await fs.writeFile(path.join(impostor, ".git"), "gitdir: fake-gitdir\n");
    try {
      expect((await discover(theaterPath)).repos.map((repo) => repo.relPath)).toEqual([""]);
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("hides worktrees whose gitdir escapes a subdirectory Theater", async () => {
    await initGitRepo(theaterPath, true);
    const subTheater = path.join(theaterPath, "sub");
    await fs.mkdir(subTheater, { recursive: true });
    // 상위 저장소의 워크트리가 하위 Theater 안에 놓이면 경로상으로는 포함되지만
    // gitdir은 <parent>/.git/worktrees/... 라서 라우트가 거부한다.
    await runGit(["worktree", "add", "-b", "inner-branch", path.join(subTheater, "inner-worktree")], { cwd: theaterPath });

    const result = await discover(subTheater);
    expect(result.repos.map(({ relPath, kind }) => ({ relPath, kind }))).toEqual([{ relPath: "", kind: "root" }]);
  });

  it("hides option-like repository rows the routes would reject", async () => {
    await initGitRepo(theaterPath, true);
    await initGitRepo(path.join(theaterPath, "-dash-repo"), true);
    await initGitRepo(path.join(theaterPath, "plain-repo"), true);
    await runGit(["worktree", "add", "-b", "dash-worktree", path.join(theaterPath, "-dash-worktree")], { cwd: theaterPath });

    const result = await discover(theaterPath);
    expect(result.repos.map((repo) => repo.relPath)).toEqual(["", "plain-repo"]);
  });

  it("includes the default context when the Theater is a subdirectory of a worktree", async () => {
    await initGitRepo(theaterPath, true);
    const subTheater = path.join(theaterPath, "sub");
    await fs.mkdir(subTheater, { recursive: true });
    await initGitRepo(path.join(subTheater, "nested"), true);

    const result = await discover(subTheater);
    expect(result.repos.map(({ relPath, kind }) => ({ relPath, kind }))).toEqual([
      { relPath: "", kind: "root" },
      { relPath: "nested", kind: "nested" },
    ]);
  });

  it("canonicalizes a symlinked Theater without reclassifying a worktree as nested", async () => {
    await initGitRepo(theaterPath, true);
    const worktree = path.join(theaterPath, "linked-worktree");
    await runGit(["worktree", "add", "-b", "canonical-worktree", worktree], { cwd: theaterPath });
    const aliasParent = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-alias-"));
    const theaterAlias = path.join(aliasParent, "theater-alias");
    await fs.symlink(theaterPath, theaterAlias);
    try {
      const realTheater = await fs.realpath(theaterAlias);
      const scanned: ScannedRepo[] = [];
      await scanRepos(theaterAlias, realTheater, realTheater, 0, 3, scanned);
      expect(scanned.find((repo) => repo.relPath === "linked-worktree")).toBeUndefined();

      const result = await discover(theaterAlias);
      expect(result.repos.filter((repo) => repo.relPath === "linked-worktree")).toEqual([]);
    } finally {
      await fs.rm(aliasParent, { recursive: true, force: true });
    }
  });

  it("stops scanning once the visit budget is spent", async () => {
    // 저장소가 하나도 없고 폭만 넓은 트리 — 개수 상한은 영원히 걸리지 않으므로 방문 예산만이 제동이다.
    await Promise.all(Array.from({ length: 12 }, (_, index) => fs.mkdir(path.join(theaterPath, `wide-${index}`), { recursive: true })));
    const realTheater = await fs.realpath(theaterPath);
    const scanned: ScannedRepo[] = [];
    const visits = { remaining: 5 };
    const truncated = await scanRepos(realTheater, realTheater, realTheater, 0, 3, scanned, REPOS_CAP, visits);
    expect(truncated).toBe(true);
    expect(visits.remaining).toBe(0);
  });

  it("shares one visit budget across every recursion branch", async () => {
    // 분기마다 예산이 리셋되면 이 트리는 예산을 소진하지 못하고 전부 방문된다.
    await Promise.all(Array.from({ length: 4 }, (_, outer) =>
      Promise.all(Array.from({ length: 4 }, (_, inner) =>
        fs.mkdir(path.join(theaterPath, `branch-${outer}`, `leaf-${inner}`), { recursive: true })))));
    const realTheater = await fs.realpath(theaterPath);
    const scanned: ScannedRepo[] = [];
    const visits = { remaining: 6 };
    const truncated = await scanRepos(realTheater, realTheater, realTheater, 0, 3, scanned, REPOS_CAP, visits);
    expect(truncated).toBe(true);
    expect(visits.remaining).toBe(0);
  });

  it("clamps depth to [1, 8]", async () => {
    await initGitRepo(path.join(theaterPath, "one"));
    await initGitRepo(path.join(theaterPath, "one", "two"));
    expect((await discover(theaterPath, { theaterId: "theater", maxDepth: 0 })).repos.map((repo) => repo.relPath)).toEqual(["one"]);

    const deep = path.join(theaterPath, ...Array.from({ length: HARD_CAP_DEPTH }, (_, index) => `d${index}`));
    await initGitRepo(deep);
    expect((await discover(theaterPath, { theaterId: "theater", maxDepth: 99 })).repos.some((repo) => repo.relPath === path.relative(theaterPath, deep))).toBe(true);
  });

  it("caps the full result and marks it truncated", async () => {
    await Promise.all(Array.from({ length: REPOS_CAP + 1 }, async (_, index) => {
      await fs.mkdir(path.join(theaterPath, `repo-${String(index).padStart(3, "0")}`, ".git"), { recursive: true });
    }));
    const result = await discover(theaterPath);
    expect(result.repos).toHaveLength(REPOS_CAP);
    expect(result.truncated).toBe(true);
  });

  it("never traverses node_modules", async () => {
    await initGitRepo(path.join(theaterPath, "node_modules", "hidden"));
    expect((await discover(theaterPath, { theaterId: "theater", maxDepth: 8 })).repos).toEqual([]);
  });

  it("never exposes absolute filesystem paths in its DTO", async () => {
    await initGitRepo(theaterPath, true);
    await initGitRepo(path.join(theaterPath, "nested"), true);
    const result = await discover(theaterPath);
    const payload = JSON.stringify(result);
    expect(payload).not.toContain(theaterPath);
    expect(Object.keys(result.repos[0] ?? {})).toEqual(["relPath", "name", "branch", "kind"]);
    expect(result.repos.every((repo) => !path.isAbsolute(repo.relPath))).toBe(true);
  });

  it("uses a short SHA for detached repositories", async () => {
    await initGitRepo(theaterPath, true);
    const head = (await runGit(["rev-parse", "HEAD"], { cwd: theaterPath })).stdout.trim();
    await runGit(["checkout", "--detach", head], { cwd: theaterPath });
    expect(await resolveRepoBranch(theaterPath)).toBe(head.slice(0, 7));
  });

  it("limits nested branch resolution to 64 Git processes", async () => {
    const resolver = vi.fn(async (repoDir: string) => path.basename(repoDir));
    const candidates = Array.from({ length: NESTED_BRANCH_CAP + 2 }, (_, index) => ({ relPath: `r${index}`, name: `r${index}`, repoDir: path.join(theaterPath, `r${index}`) }));
    const resolved = await resolveNestedRepoCandidates(candidates, candidates.length, resolver);
    expect(resolver).toHaveBeenCalledTimes(NESTED_BRANCH_CAP);
    expect(resolved[NESTED_BRANCH_CAP]?.branch).toBe("");
    expect(resolved[NESTED_BRANCH_CAP + 1]?.branch).toBe("");
  });

  it("does not resolve nested branches after the result cap is full", async () => {
    const resolver = vi.fn(async () => "unused");
    const candidates = [{ relPath: "nested", name: "nested", repoDir: path.join(theaterPath, "nested") }];
    expect(await resolveNestedRepoCandidates(candidates, 0, resolver)).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
  });
});
