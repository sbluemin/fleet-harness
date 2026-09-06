import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { handleRepositoryCommit } from "../server/commit.js";
import { handleRepositoryCommitFile } from "../server/commit-file.js";
import { handleRepositoryCompare } from "../server/compare.js";
import { handleRepositoryCompareFile } from "../server/compare-file.js";
import { handleRepositoryChanged, handleRepositoryFile } from "../server/diff.js";
import { handleRepositoryFetch } from "../server/fetch.js";
import { runGit } from "../server/git-executor.js";
import { handleRepositoryLog } from "../server/log.js";
import { handleRepositoryRefs } from "../server/refs.js";
import { handleRepositoryWorktrees } from "../server/worktrees.js";

interface JsonWrite {
  readonly status: number;
  readonly payload: unknown;
}

interface RootRepoFixture {
  readonly theaterPath: string;
  readonly head: string;
  readonly typeChangeHead: string;
  readonly renameHead: string;
  readonly mergeHead: string;
}

interface ChangedPayload {
  readonly files: readonly { readonly path: string; readonly status: string }[];
}

interface CommitPayload {
  readonly meta: { readonly subject: string };
  readonly files: readonly { readonly path: string; readonly status?: string }[];
}

interface ContentPayload {
  readonly content: string;
}

interface LogPayload {
  readonly commits: readonly { readonly subject: string }[];
  readonly hasMore: boolean;
}

const handlers = [
  ["worktrees", handleRepositoryWorktrees, { theaterId: "theater" }],
  ["changed", handleRepositoryChanged, { theaterId: "theater" }],
  ["fetch", handleRepositoryFetch, { theaterId: "theater" }],
  ["file", handleRepositoryFile, { theaterId: "theater", filePath: "file", mode: "unified" }],
  ["commit", handleRepositoryCommit, { theaterId: "theater", ref: "1234567" }],
  ["commit-file", handleRepositoryCommitFile, { theaterId: "theater", ref: "1234567", filePath: "file" }],
  ["compare", handleRepositoryCompare, { theaterId: "theater", base: "refs/heads/main", head: "HEAD" }],
  ["compare-file", handleRepositoryCompareFile, { theaterId: "theater", base: "refs/heads/main", head: "HEAD", filePath: "file" }],
  ["log", handleRepositoryLog, { theaterId: "theater" }],
  ["refs", handleRepositoryRefs, { theaterId: "theater" }],
] as const;

async function initGitRepo(dir: string): Promise<void> {
  await runGit(["init"], { cwd: dir });
  await runGit(["config", "user.email", "test@test.com"], { cwd: dir });
  await runGit(["config", "user.name", "Test"], { cwd: dir });
}

async function createRootRepo(tmpDir: string): Promise<RootRepoFixture> {
  const theaterPath = path.join(tmpDir, "repo");
  const insidePath = path.join(theaterPath, "inside");
  const outsidePath = path.join(theaterPath, "outside");
  await fs.mkdir(insidePath, { recursive: true });
  await fs.mkdir(outsidePath, { recursive: true });
  await initGitRepo(theaterPath);

  await fs.writeFile(path.join(insidePath, "changed.txt"), "before\n");
  await fs.writeFile(path.join(insidePath, "rename-old.txt"), "rename\n");
  await fs.writeFile(path.join(insidePath, "type-change.txt"), "regular file\n");
  await fs.writeFile(path.join(outsidePath, "base.txt"), "outside before\n");
  await fs.writeFile(path.join(theaterPath, "..notes"), "before\n");
  await runGit(["add", "."], { cwd: theaterPath });
  await runGit(["commit", "-m", "base context commit"], { cwd: theaterPath });

  await fs.writeFile(path.join(outsidePath, "outside-only.txt"), "outside only\n");
  await runGit(["add", "."], { cwd: theaterPath });
  await runGit(["commit", "-m", "outside only commit"], { cwd: theaterPath });

  await fs.writeFile(path.join(insidePath, "committed.txt"), "inside commit\n");
  await fs.writeFile(path.join(outsidePath, "committed.txt"), "outside commit\n");
  await fs.writeFile(path.join(theaterPath, "..notes"), "after\n");
  await runGit(["add", "."], { cwd: theaterPath });
  await runGit(["commit", "-m", "mixed context commit"], { cwd: theaterPath });
  const head = (await runGit(["rev-parse", "HEAD"], { cwd: theaterPath })).stdout.trim();

  const mainBranch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: theaterPath })).stdout.trim();
  await runGit(["checkout", "-b", "type-change-fixture"], { cwd: theaterPath });
  await fs.rm(path.join(insidePath, "type-change.txt"));
  await fs.symlink("changed.txt", path.join(insidePath, "type-change.txt"));
  await runGit(["add", "inside/type-change.txt"], { cwd: theaterPath });
  await runGit(["commit", "-m", "type change fixture"], { cwd: theaterPath });
  const typeChangeHead = (await runGit(["rev-parse", "HEAD"], { cwd: theaterPath })).stdout.trim();
  await runGit(["checkout", mainBranch], { cwd: theaterPath });

  await runGit(["checkout", "-b", "rename-fixture"], { cwd: theaterPath });
  await runGit(["mv", "inside/rename-old.txt", "inside/rename-new.txt"], { cwd: theaterPath });
  await runGit(["commit", "-m", "rename fixture"], { cwd: theaterPath });
  const renameHead = (await runGit(["rev-parse", "HEAD"], { cwd: theaterPath })).stdout.trim();
  await runGit(["checkout", mainBranch], { cwd: theaterPath });

  await runGit(["checkout", "-b", "merge-side"], { cwd: theaterPath });
  await fs.writeFile(path.join(theaterPath, "merge-side.txt"), "from merge side\n");
  await runGit(["add", "merge-side.txt"], { cwd: theaterPath });
  await runGit(["commit", "-m", "merge side"], { cwd: theaterPath });
  await runGit(["checkout", mainBranch], { cwd: theaterPath });
  await fs.writeFile(path.join(theaterPath, "merge-main.txt"), "from merge main\n");
  await runGit(["add", "merge-main.txt"], { cwd: theaterPath });
  await runGit(["commit", "-m", "merge main"], { cwd: theaterPath });
  await runGit(["merge", "--no-ff", "merge-side", "-m", "merge fixture"], { cwd: theaterPath });
  const mergeHead = (await runGit(["rev-parse", "HEAD"], { cwd: theaterPath })).stdout.trim();

  await fs.writeFile(path.join(insidePath, "changed.txt"), "after\n");
  await fs.writeFile(path.join(outsidePath, "base.txt"), "outside after\n");
  await runGit(["mv", "inside/rename-old.txt", "inside/rename-new.txt"], { cwd: theaterPath });

  return { theaterPath, head, typeChangeHead, renameHead, mergeHead };
}

function makeContext(theaterPath: string, body: Record<string, unknown>, writes: JsonWrite[]): FleetPluginServerContext {
  return {
    host: {
      http: {
        readJsonBody: async () => body,
        writeJson: (_res: unknown, status: number, payload: unknown) => { writes.push({ status, payload }); },
      },
      security: { isTerminalAuthorized: () => true },
      paths: { resolveTheaterPath: () => theaterPath },
    },
  } as unknown as FleetPluginServerContext;
}

function readPayload<T>(writes: readonly JsonWrite[]): T {
  expect(writes).toHaveLength(1);
  expect(writes[0]?.status).toBe(200);
  return writes[0]?.payload as T;
}

describe("Repository Theater-root Git routes", () => {
  let tmpDir: string;
  let fixture: RootRepoFixture;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-root-"));
    fixture = await createRootRepo(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects repoRel symlinks that escape the Theater", async () => {
    const outside = path.join(tmpDir, "outside-repository");
    await fs.mkdir(outside);
    await initGitRepo(outside);
    await fs.symlink(outside, path.join(fixture.theaterPath, "escaped-repository"));
    const writes: JsonWrite[] = [];
    await handleRepositoryChanged(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", repoRel: "escaped-repository" }, writes),
    );
    expect(writes).toEqual([{ status: 400, payload: { error: "invalid_repo" } }]);
  });

  it("rejects a repoRel whose gitfile points to a gitdir outside the Theater", async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-route-outside-"));
    await runGit(["init"], { cwd: outsideRoot });
    const impostor = path.join(fixture.theaterPath, "impostor-gitfile");
    await fs.mkdir(impostor, { recursive: true });
    await fs.writeFile(path.join(impostor, ".git"), `gitdir: ${path.join(outsideRoot, ".git")}\n`);
    try {
      const writes: JsonWrite[] = [];
      await handleRepositoryChanged(
        { method: "POST" } as never,
        {} as never,
        makeContext(fixture.theaterPath, { theaterId: "theater", repoRel: "impostor-gitfile" }, writes),
      );
      expect(writes).toEqual([{ status: 400, payload: { error: "invalid_repo" } }]);
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("changed returns Theater-root-relative paths and file opens the matching hunk", async () => {
    const changedWrites: JsonWrite[] = [];
    await handleRepositoryChanged(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater" }, changedWrites),
    );

    const changed = readPayload<ChangedPayload>(changedWrites);
    expect(changed.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "inside/changed.txt", status: "M" }),
      expect.objectContaining({ path: "outside/base.txt", status: "M" }),
      expect.objectContaining({ path: "inside/rename-new.txt", status: "R" }),
    ]));

    const fileWrites: JsonWrite[] = [];
    await handleRepositoryFile(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", filePath: "inside/changed.txt", mode: "unified" }, fileWrites),
    );

    const file = readPayload<ContentPayload>(fileWrites);
    expect(file.content).toContain("diff --git a/inside/changed.txt b/inside/changed.txt");
    expect(file.content).toContain("+after");
  });

  it("하위 디렉터리 Theater의 history는 Theater 밖 커밋을 제외한다", async () => {
    const outerRepo = path.join(tmpDir, "outer-repo");
    const theaterPath = path.join(outerRepo, "theater");
    const outsidePath = path.join(outerRepo, "outside");
    await fs.mkdir(theaterPath, { recursive: true });
    await fs.mkdir(outsidePath, { recursive: true });
    await initGitRepo(outerRepo);

    await fs.writeFile(path.join(theaterPath, "inside.txt"), "inside\n");
    await runGit(["add", "."], { cwd: outerRepo });
    await runGit(["commit", "-m", "inside Theater commit"], { cwd: outerRepo });
    await fs.writeFile(path.join(outsidePath, "outside.txt"), "outside\n");
    await runGit(["add", "."], { cwd: outerRepo });
    await runGit(["commit", "-m", "outside Theater commit"], { cwd: outerRepo });

    const writes: JsonWrite[] = [];
    await handleRepositoryLog(
      { method: "POST" } as never,
      {} as never,
      makeContext(theaterPath, { theaterId: "theater" }, writes),
    );

    const subjects = readPayload<LogPayload>(writes).commits.map((commit) => commit.subject);
    expect(subjects).toContain("inside Theater commit");
    expect(subjects).not.toContain("outside Theater commit");
  });
});

describe("changed route non-Git Theater handling", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-no-git-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns the client-friendly no_git_repo notice contract", async () => {
    const writes: JsonWrite[] = [];
    await handleRepositoryChanged(
      { method: "POST" } as never,
      {} as never,
      makeContext(tmpDir, { theaterId: "theater" }, writes),
    );
    expect(writes).toEqual([{ status: 422, payload: { error: "no_git_repo" } }]);
  });
});
