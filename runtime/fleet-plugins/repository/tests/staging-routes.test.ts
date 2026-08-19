import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRepositoryCommitCreate, classifyCommitError } from "../server/commit-create.js";
import { runGit } from "../server/git-executor.js";
import { handleRepositoryDiscard, handleRepositoryStage, handleRepositoryUnstage, readStagePaths } from "../server/stage.js";
import { handleRepositoryStash, readStashAction } from "../server/stash.js";
import { handleRepositoryStatus, parseStatusV2 } from "../server/status.js";
import type { StatusResult } from "../server/types.js";

interface JsonWrite {
  readonly status: number;
  readonly payload: unknown;
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
      operations: { list: () => [] },
    },
  } as unknown as FleetPluginServerContext;
}

const req = { method: "POST" } as never;
const res = {} as never;

async function seedRepo(tmpDir: string): Promise<string> {
  const repo = path.join(tmpDir, "repo");
  await fs.mkdir(repo);
  await runGit(["init"], { cwd: repo });
  await runGit(["config", "user.email", "test@test.com"], { cwd: repo });
  await runGit(["config", "user.name", "Test"], { cwd: repo });
  await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
  await runGit(["add", "tracked.txt"], { cwd: repo });
  await runGit(["commit", "-m", "base"], { cwd: repo });
  return repo;
}

async function readStatus(repo: string): Promise<StatusResult> {
  const writes: JsonWrite[] = [];
  await handleRepositoryStatus(req, res, makeContext(repo, { theaterId: "t" }, writes));
  expect(writes[0]!.status).toBe(200);
  return writes[0]!.payload as StatusResult;
}

describe("Repository staging routes", () => {
  let tmpDir: string;
  let repo: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-staging-"));
    repo = await seedRepo(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("splits status by stage axis and lists a re-modified file on both", async () => {
    await fs.writeFile(path.join(repo, "tracked.txt"), "staged edit\n");
    await runGit(["add", "tracked.txt"], { cwd: repo });
    await fs.appendFile(path.join(repo, "tracked.txt"), "worktree edit\n");
    await fs.writeFile(path.join(repo, "fresh.txt"), "new\n");

    const status = await readStatus(repo);
    expect(status.staged.map((entry) => entry.path)).toEqual(["tracked.txt"]);
    expect(status.unstaged.map((entry) => entry.path).sort()).toEqual(["fresh.txt", "tracked.txt"]);
    expect(status.unstaged.find((entry) => entry.path === "fresh.txt")?.status).toBe("U");
    expect(status.staged[0]!.additions).toBeGreaterThan(0);
  });

  it("stages, unstages, and discards through the verbs", async () => {
    await fs.writeFile(path.join(repo, "fresh.txt"), "new\n");
    await fs.appendFile(path.join(repo, "tracked.txt"), "edit\n");

    let writes: JsonWrite[] = [];
    await handleRepositoryStage(req, res, makeContext(repo, { theaterId: "t", paths: ["fresh.txt", "tracked.txt"] }, writes));
    expect(writes[0]!.status).toBe(200);
    let status = await readStatus(repo);
    expect(status.staged.map((entry) => entry.path).sort()).toEqual(["fresh.txt", "tracked.txt"]);
    expect(status.unstaged).toEqual([]);

    writes = [];
    await handleRepositoryUnstage(req, res, makeContext(repo, { theaterId: "t", paths: ["fresh.txt"] }, writes));
    expect(writes[0]!.status).toBe(200);
    status = await readStatus(repo);
    expect(status.unstaged.map((entry) => entry.path)).toEqual(["fresh.txt"]);

    writes = [];
    await handleRepositoryDiscard(req, res, makeContext(repo, { theaterId: "t", untrackedPaths: ["fresh.txt"] }, writes));
    expect(writes[0]!.status).toBe(200);
    await expect(fs.stat(path.join(repo, "fresh.txt"))).rejects.toThrow();
  });

  it("discards tracked worktree edits back to the index", async () => {
    await fs.appendFile(path.join(repo, "tracked.txt"), "reckless edit\n");
    const writes: JsonWrite[] = [];
    await handleRepositoryDiscard(req, res, makeContext(repo, { theaterId: "t", paths: ["tracked.txt"] }, writes));
    expect(writes[0]!.status).toBe(200);
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("base\n");
  });

  it("rejects escaping, absolute, and empty path lists before touching git", () => {
    expect(readStagePaths(["../outside.txt"])).toBeNull();
    expect(readStagePaths(["/etc/passwd"])).toBeNull();
    expect(readStagePaths([])).toBeNull();
    expect(readStagePaths(["ok.txt", 42 as unknown as string])).toBeNull();
    // 옵션처럼 생긴 이름은 literal pathspec으로 처리될 뿐 검증은 통과한다.
    expect(readStagePaths(["--force"])).toEqual(["--force"]);
  });

  it("creates a commit from the staged files and amends it", async () => {
    await fs.appendFile(path.join(repo, "tracked.txt"), "edit\n");
    await runGit(["add", "tracked.txt"], { cwd: repo });

    let writes: JsonWrite[] = [];
    await handleRepositoryCommitCreate(req, res, makeContext(repo, { theaterId: "t", subject: "feat: edit tracked", message: "body line" }, writes));
    expect(writes[0]!.status).toBe(200);
    const sha = (writes[0]!.payload as { readonly sha: string }).sha;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const log = (await runGit(["log", "-1", "--format=%s%n%b"], { cwd: repo })).stdout;
    expect(log).toContain("feat: edit tracked");
    expect(log).toContain("body line");

    writes = [];
    await handleRepositoryCommitCreate(req, res, makeContext(repo, { theaterId: "t", subject: "feat: edit tracked (amended)", amend: true }, writes));
    expect(writes[0]!.status).toBe(200);
    expect((await runGit(["log", "-1", "--format=%s"], { cwd: repo })).stdout.trim()).toBe("feat: edit tracked (amended)");
    // amend는 새 커밋을 쌓지 않는다.
    expect((await runGit(["rev-list", "--count", "HEAD"], { cwd: repo })).stdout.trim()).toBe("2");
  });

  it("refuses a commit with nothing staged and an invalid message", async () => {
    let writes: JsonWrite[] = [];
    await handleRepositoryCommitCreate(req, res, makeContext(repo, { theaterId: "t", subject: "feat: empty" }, writes));
    expect(writes[0]).toEqual({ status: 422, payload: { error: "nothing_to_commit" } });

    writes = [];
    await handleRepositoryCommitCreate(req, res, makeContext(repo, { theaterId: "t", subject: "   " }, writes));
    expect(writes[0]!.status).toBe(400);
  });

  it("classifies identity failures from git stderr", () => {
    expect(classifyCommitError("fatal: unable to auto-detect email address")).toBe("identity_missing");
    expect(classifyCommitError("*** Please tell me who you are.")).toBe("identity_missing");
    expect(classifyCommitError("some other failure")).toBeNull();
  });

  it("saves and pops a stash through the verb, untracked files included", async () => {
    await fs.appendFile(path.join(repo, "tracked.txt"), "wip\n");
    await fs.writeFile(path.join(repo, "loose.txt"), "loose\n");

    let writes: JsonWrite[] = [];
    await handleRepositoryStash(req, res, makeContext(repo, { theaterId: "t", action: "save", message: "wip stash" }, writes));
    expect(writes[0]!.status).toBe(200);
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("base\n");
    await expect(fs.stat(path.join(repo, "loose.txt"))).rejects.toThrow();

    writes = [];
    await handleRepositoryStash(req, res, makeContext(repo, { theaterId: "t", action: "pop", name: "stash@{0}" }, writes));
    expect(writes[0]!.status).toBe(200);
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toContain("wip");
    expect(await fs.readFile(path.join(repo, "loose.txt"), "utf8")).toBe("loose\n");
  });

  it("rejects malformed stash names and unknown actions", async () => {
    const writes: JsonWrite[] = [];
    await handleRepositoryStash(req, res, makeContext(repo, { theaterId: "t", action: "pop", name: "stash@{0}; rm -rf" }, writes));
    expect(writes[0]!.status).toBe(400);
    expect(readStashAction("explode")).toBeNull();
    expect(readStashAction("pop")).toBe("pop");
  });

  it("reports nothing_to_stash on a clean tree", async () => {
    const writes: JsonWrite[] = [];
    await handleRepositoryStash(req, res, makeContext(repo, { theaterId: "t", action: "save" }, writes));
    expect(writes[0]).toEqual({ status: 422, payload: { error: "nothing_to_stash" } });
  });
});

describe("parseStatusV2", () => {
  const empty = new Map<string, { readonly additions: number; readonly deletions: number }>();

  it("keeps spaces in paths and splits rename records", () => {
    const records = [
      "1 M. N... 100644 100644 100644 abc def with space.txt",
      "2 R. N... 100644 100644 100644 abc def R100 renamed new.txt",
      "old name.txt",
      "? loose file.txt",
    ].join("\0") + "\0";
    const parsed = parseStatusV2(records, empty, empty);
    expect(parsed.staged.map((entry) => entry.path)).toEqual(["with space.txt", "renamed new.txt"]);
    expect(parsed.staged[1]).toMatchObject({ oldPath: "old name.txt", status: "R" });
    expect(parsed.unstaged.map((entry) => entry.path)).toEqual(["loose file.txt"]);
  });

  it("lists a both-axis file in both lists and surfaces conflicts as U", () => {
    const records = [
      "1 MM N... 100644 100644 100644 abc def both.txt",
      "u UU N... 100644 100644 100644 100644 abc def ghi conflicted.txt",
    ].join("\0") + "\0";
    const parsed = parseStatusV2(records, empty, empty);
    expect(parsed.staged.map((entry) => entry.path)).toEqual(["both.txt"]);
    expect(parsed.unstaged.map((entry) => entry.path)).toEqual(["both.txt", "conflicted.txt"]);
    expect(parsed.unstaged[1]!.status).toBe("U");
  });
});
