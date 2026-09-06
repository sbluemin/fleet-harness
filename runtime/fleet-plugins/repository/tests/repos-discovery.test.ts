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

  it("never exposes absolute filesystem paths in its DTO", async () => {
    await initGitRepo(theaterPath, true);
    await initGitRepo(path.join(theaterPath, "nested"), true);
    const result = await discover(theaterPath);
    const payload = JSON.stringify(result);
    expect(payload).not.toContain(theaterPath);
    expect(Object.keys(result.repos[0] ?? {})).toEqual(["relPath", "name", "branch", "kind"]);
    expect(result.repos.every((repo) => !path.isAbsolute(repo.relPath))).toBe(true);
  });
});
