import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { handleDiffCommit } from "../server/commit.js";
import { handleDiffChanged, handleDiffFile } from "../server/diff.js";
import { runGit } from "../server/git-executor.js";
import { handleDiffLog } from "../server/log.js";

// ─── types ─────────────────────────────────────────────────────────────────

interface JsonWrite {
  readonly status: number;
  readonly payload: unknown;
}

interface ScopedRepoFixture {
  readonly theaterPath: string;
  readonly head: string;
}

interface ChangedPayload {
  readonly files: readonly { readonly path: string; readonly status: string }[];
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
  await fs.writeFile(path.join(outsidePath, "base.txt"), "outside before\n");
  await runGit(["add", "."], { cwd: theaterPath });
  await runGit(["commit", "-m", "base context commit"], { cwd: theaterPath });

  await fs.writeFile(path.join(outsidePath, "outside-only.txt"), "outside only\n");
  await runGit(["add", "."], { cwd: theaterPath });
  await runGit(["commit", "-m", "outside only commit"], { cwd: theaterPath });

  await fs.writeFile(path.join(insidePath, "committed.txt"), "inside commit\n");
  await fs.writeFile(path.join(outsidePath, "committed.txt"), "outside commit\n");
  await runGit(["add", "."], { cwd: theaterPath });
  await runGit(["commit", "-m", "mixed context commit"], { cwd: theaterPath });
  const head = (await runGit(["rev-parse", "HEAD"], { cwd: theaterPath })).stdout.trim();

  await fs.writeFile(path.join(insidePath, "changed.txt"), "after\n");
  await fs.writeFile(path.join(outsidePath, "base.txt"), "outside after\n");
  await runGit(["mv", path.join(INSIDE_DIR, "rename-old.txt"), path.join(INSIDE_DIR, "rename-new.txt")], { cwd: theaterPath });

  return { theaterPath, head };
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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-diff-context-"));
    fixture = await createScopedRepo(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("changed returns only selected-cwd-relative paths and file opens the matching hunk", async () => {
    const changedWrites: JsonWrite[] = [];
    await handleDiffChanged(
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
    await handleDiffFile(
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
    await handleDiffLog(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", subPath: INSIDE_DIR }, logWrites),
    );

    const log = readPayload<LogPayload>(logWrites);
    expect(log.commits.map((commit) => commit.subject)).toContain("mixed context commit");
    expect(log.commits.map((commit) => commit.subject)).not.toContain("outside only commit");

    const commitWrites: JsonWrite[] = [];
    await handleDiffCommit(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, {
        theaterId: "theater",
        subPath: INSIDE_DIR,
        ref: fixture.head,
      }, commitWrites),
    );

    const commit = readPayload<ContentPayload>(commitWrites);
    expect(commit.content).toContain("diff --git a/committed.txt b/committed.txt");
    expect(commit.content).not.toContain(`${OUTSIDE_DIR}/committed.txt`);
    expect(commit.content).not.toContain(`${INSIDE_DIR}/committed.txt`);
  });
});
