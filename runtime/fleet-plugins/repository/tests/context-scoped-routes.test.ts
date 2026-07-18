import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { handleRepositoryCommit } from "../server/commit.js";
import { handleRepositoryCommitFile } from "../server/commit-file.js";
import { handleRepositoryChanged, handleRepositoryFile } from "../server/diff.js";
import { runGit } from "../server/git-executor.js";
import { handleRepositoryLog } from "../server/log.js";

// ─── types ─────────────────────────────────────────────────────────────────

interface JsonWrite {
  readonly status: number;
  readonly payload: unknown;
}

interface ScopedRepoFixture {
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
  readonly files: readonly { readonly path: string }[];
}

interface ContentPayload {
  readonly content: string;
}

interface LogPayload {
  readonly commits: readonly { readonly subject: string }[];
}

// ─── constants ─────────────────────────────────────────────────────────────

const INSIDE_DIR = "inside";
const OUTSIDE_DIR = "outside";

// ─── helpers ───────────────────────────────────────────────────────────────

async function initGitRepo(dir: string): Promise<void> {
  await runGit(["init"], { cwd: dir });
  await runGit(["config", "user.email", "test@test.com"], { cwd: dir });
  await runGit(["config", "user.name", "Test"], { cwd: dir });
}

async function createScopedRepo(tmpDir: string): Promise<ScopedRepoFixture> {
  const theaterPath = path.join(tmpDir, "repo");
  const insidePath = path.join(theaterPath, INSIDE_DIR);
  const outsidePath = path.join(theaterPath, OUTSIDE_DIR);
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
  await runGit(["add", path.join(INSIDE_DIR, "type-change.txt")], { cwd: theaterPath });
  await runGit(["commit", "-m", "type change fixture"], { cwd: theaterPath });
  const typeChangeHead = (await runGit(["rev-parse", "HEAD"], { cwd: theaterPath })).stdout.trim();
  await runGit(["checkout", mainBranch], { cwd: theaterPath });

  await runGit(["checkout", "-b", "rename-fixture"], { cwd: theaterPath });
  await runGit(["mv", path.join(INSIDE_DIR, "rename-old.txt"), path.join(INSIDE_DIR, "rename-new.txt")], { cwd: theaterPath });
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
  await runGit(["mv", path.join(INSIDE_DIR, "rename-old.txt"), path.join(INSIDE_DIR, "rename-new.txt")], { cwd: theaterPath });

  return { theaterPath, head, typeChangeHead, renameHead, mergeHead };
}

function makeContext(
  theaterPath: string,
  body: Record<string, unknown>,
  writes: JsonWrite[],
): FleetPluginServerContext {
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

// ─── tests ─────────────────────────────────────────────────────────────────

describe("selected subdirectory diff route scope", () => {
  let tmpDir: string;
  let fixture: ScopedRepoFixture;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-context-"));
    fixture = await createScopedRepo(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("changed returns only selected-cwd-relative paths and file opens the matching hunk", async () => {
    const changedWrites: JsonWrite[] = [];
    await handleRepositoryChanged(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", subPath: INSIDE_DIR }, changedWrites),
    );

    const changed = readPayload<ChangedPayload>(changedWrites);
    expect(changed.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "changed.txt", status: "M" }),
      expect.objectContaining({ path: "rename-new.txt", status: "R" }),
    ]));
    expect(changed.files.every((file) => !file.path.startsWith(`${OUTSIDE_DIR}/`))).toBe(true);
    expect(changed.files.every((file) => !file.path.startsWith(`${INSIDE_DIR}/`))).toBe(true);

    const fileWrites: JsonWrite[] = [];
    await handleRepositoryFile(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, {
        theaterId: "theater",
        subPath: INSIDE_DIR,
        filePath: "changed.txt",
        mode: "unified",
      }, fileWrites),
    );

    const file = readPayload<ContentPayload>(fileWrites);
    expect(file.content).toContain("diff --git a/changed.txt b/changed.txt");
    expect(file.content).toContain("+after");
  });

  it("relative git output makes both rename paths selected-cwd-relative", async () => {
    const selectedCwd = path.join(fixture.theaterPath, INSIDE_DIR);
    const [nameStatus, numstat] = await Promise.all([
      runGit(["diff", "HEAD", "--relative", "--name-status", "--diff-filter=MADR", "--", "."], { cwd: selectedCwd }),
      runGit(["diff", "HEAD", "--relative", "--numstat", "--diff-filter=MADR", "--", "."], { cwd: selectedCwd }),
    ]);

    expect(nameStatus.stdout).toContain("R100\trename-old.txt\trename-new.txt");
    expect(numstat.stdout).toContain("0\t0\trename-old.txt => rename-new.txt");
    expect(nameStatus.stdout).not.toContain(`${INSIDE_DIR}/rename-`);
    expect(numstat.stdout).not.toContain(`${INSIDE_DIR}/rename-`);
  });

  it("log and commit detail stay scoped to the selected context", async () => {
    const logWrites: JsonWrite[] = [];
    await handleRepositoryLog(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", subPath: INSIDE_DIR }, logWrites),
    );

    const log = readPayload<LogPayload>(logWrites);
    expect(log.commits.map((commit) => commit.subject)).toContain("mixed context commit");
    expect(log.commits.map((commit) => commit.subject)).not.toContain("outside only commit");

    const commitWrites: JsonWrite[] = [];
    await handleRepositoryCommit(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, {
        theaterId: "theater",
        subPath: INSIDE_DIR,
        ref: fixture.head,
      }, commitWrites),
    );

    const commit = readPayload<CommitPayload>(commitWrites);
    expect(commit.meta.subject).toBe("mixed context commit");
    expect(commit.files.map((file) => file.path)).toContain("committed.txt");
    expect(commit.files.map((file) => file.path)).not.toContain(`${OUTSIDE_DIR}/committed.txt`);
  });

  it("returns a selected commit file and neutralizes option-like paths as literal pathspecs", async () => {
    const fileWrites: JsonWrite[] = [];
    await handleRepositoryCommitFile(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", subPath: INSIDE_DIR, ref: fixture.head, filePath: "committed.txt" }, fileWrites),
    );
    const file = readPayload<ContentPayload>(fileWrites);
    expect(file.content).toContain("diff --git a/inside/committed.txt b/inside/committed.txt");

    // A leading-dash path is no longer rejected (a real `-file` must be openable); the `--` separator
    // and `:(literal)` prefix mean `--stat` reaches git as a literal pathspec (no such file → empty),
    // never as an executed `--stat` option, so no diffstat is injected.
    const optionLikeWrites: JsonWrite[] = [];
    await handleRepositoryCommitFile(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", subPath: INSIDE_DIR, ref: fixture.head, filePath: "--stat" }, optionLikeWrites),
    );
    expect(readPayload<ContentPayload>(optionLikeWrites).content).toBe("");
  });

  it("treats commit and worktree file paths as literal pathspecs", async () => {
    const commitWrites: JsonWrite[] = [];
    await handleRepositoryCommitFile(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", subPath: INSIDE_DIR, ref: fixture.head, filePath: ":(top)outside/committed.txt" }, commitWrites),
    );
    expect(readPayload<ContentPayload>(commitWrites).content).toBe("");

    const worktreeWrites: JsonWrite[] = [];
    await handleRepositoryFile(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", subPath: INSIDE_DIR, filePath: ":(top)outside/base.txt", mode: "unified" }, worktreeWrites),
    );
    expect(readPayload<ContentPayload>(worktreeWrites).content).toBe("");
  });

  it("renders a renamed commit file with both literal paths", async () => {
    const writes: JsonWrite[] = [];
    await handleRepositoryCommitFile(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", subPath: INSIDE_DIR, ref: fixture.renameHead, filePath: "rename-new.txt", oldPath: "rename-old.txt" }, writes),
    );
    const content = readPayload<ContentPayload>(writes).content;
    expect(content).toContain("similarity index 100%");
    expect(content).toMatch(/rename from .*rename-old\.txt/);
    expect(content).toMatch(/rename to .*rename-new\.txt/);
  });

  it("lists a type change and loads its per-file diff", async () => {
    const commitWrites: JsonWrite[] = [];
    await handleRepositoryCommit(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", subPath: INSIDE_DIR, ref: fixture.typeChangeHead }, commitWrites),
    );
    expect(readPayload<CommitPayload>(commitWrites).files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "type-change.txt", status: "T" })]));

    const fileWrites: JsonWrite[] = [];
    await handleRepositoryCommitFile(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", subPath: INSIDE_DIR, ref: fixture.typeChangeHead, filePath: "type-change.txt" }, fileWrites),
    );
    const content = readPayload<ContentPayload>(fileWrites).content;
    expect(content).toContain("deleted file mode 100644");
    expect(content).toContain("new file mode 120000");
  });

  it("diffs a real merge against its first parent and loads its selected file", async () => {
    const commitWrites: JsonWrite[] = [];
    await handleRepositoryCommit(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", ref: fixture.mergeHead }, commitWrites),
    );
    const commit = readPayload<CommitPayload>(commitWrites);
    expect(commit.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "merge-side.txt" })]));

    const fileWrites: JsonWrite[] = [];
    await handleRepositoryCommitFile(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", ref: fixture.mergeHead, filePath: "merge-side.txt" }, fileWrites),
    );
    expect(readPayload<ContentPayload>(fileWrites).content).toContain("diff --git a/merge-side.txt b/merge-side.txt");
  });

  it("allows a legitimate in-repository ..-prefixed filename", async () => {
    const writes: JsonWrite[] = [];
    await handleRepositoryCommitFile(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", ref: fixture.head, filePath: "..notes" }, writes),
    );
    expect(readPayload<ContentPayload>(writes).content).toContain("diff --git a/..notes b/..notes");
  });
});

describe("changed route non-Git theater handling", () => {
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
