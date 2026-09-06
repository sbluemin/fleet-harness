import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { runGit } from "../server/git-executor.js";
import type { WorktreesResult } from "../server/types.js";
import { handleRepositoryWorktrees } from "../server/worktrees.js";

interface JsonWrite { readonly status: number; readonly payload: unknown }

async function initGitRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await runGit(["init"], { cwd: dir });
  await runGit(["config", "user.email", "test@test.com"], { cwd: dir });
  await runGit(["config", "user.name", "Test"], { cwd: dir });
  await fs.writeFile(path.join(dir, "base.txt"), "base\n");
  await runGit(["add", "."], { cwd: dir });
  await runGit(["commit", "-m", "base"], { cwd: dir });
}

function makeContext(theaterPath: string, body: Record<string, unknown>, writes: JsonWrite[]): FleetPluginServerContext {
  return { host: { http: { readJsonBody: async () => body, writeJson: (_res: unknown, status: number, payload: unknown) => writes.push({ status, payload }) }, security: { isTerminalAuthorized: () => true }, paths: { resolveTheaterPath: () => theaterPath } } } as unknown as FleetPluginServerContext;
}

async function listWorktrees(theaterPath: string, body: Record<string, unknown> = { theaterId: "theater" }): Promise<WorktreesResult> {
  const writes: JsonWrite[] = [];
  await handleRepositoryWorktrees({ method: "POST" } as never, {} as never, makeContext(theaterPath, body, writes));
  expect(writes).toHaveLength(1);
  expect(writes[0]?.status).toBe(200);
  return writes[0]?.payload as WorktreesResult;
}

describe("Repository worktrees route", () => {
  let theaterPath: string;

  beforeEach(async () => {
    theaterPath = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-worktrees-"));
    await initGitRepo(theaterPath);
  });
  afterEach(async () => { await fs.rm(theaterPath, { recursive: true, force: true }); });

  it("excludes worktrees outside the Theater", async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-outside-worktrees-"));
    const outside = path.join(outsideRoot, "linked");
    try {
      await runGit(["worktree", "add", "-b", "outside-branch", outside], { cwd: theaterPath });
      expect((await listWorktrees(theaterPath)).worktrees.map((entry) => entry.relPath)).toEqual([""]);
    } finally {
      await runGit(["worktree", "remove", "--force", outside], { cwd: theaterPath });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("excludes a listed worktree whose gitdir escapes the Theater", async () => {
    const linked = path.join(theaterPath, "escaped-gitdir");
    await runGit(["worktree", "add", "-b", "escaped-branch", linked], { cwd: theaterPath });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-outside-gitdir-"));
    await initGitRepo(outside);
    await fs.writeFile(path.join(linked, ".git"), `gitdir: ${path.join(outside, ".git")}\n`);
    try {
      expect((await listWorktrees(theaterPath)).worktrees.map((entry) => entry.relPath)).toEqual([""]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("excludes option-like worktree paths", async () => {
    await runGit(["worktree", "add", "-b", "dash-branch", path.join(theaterPath, "-dash")], { cwd: theaterPath });
    expect((await listWorktrees(theaterPath)).worktrees.map((entry) => entry.relPath)).toEqual([""]);
  });
});
