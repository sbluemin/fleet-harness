import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runGit } from "../server/git-executor.js";
import { classifyPullError, classifyPushError, handleRepositoryPull, handleRepositoryPush } from "../server/remote.js";
import { handleRepositoryTree, isSafeTreeDirPath, parseTreeEntries } from "../server/tree.js";
import { handleRepositoryWorkstate, parseAheadBehind } from "../server/workstate.js";
import type { TreeResult, WorkstateResult } from "../server/types.js";

interface JsonWrite {
  readonly status: number;
  readonly payload: unknown;
}

interface StubOperation {
  readonly id: string;
  readonly title: string;
  readonly payload: { readonly cwd?: string } | null;
}

function makeContext(theaterPath: string, body: Record<string, unknown>, writes: JsonWrite[], operations: readonly StubOperation[] = []): FleetPluginServerContext {
  return {
    host: {
      http: {
        readJsonBody: async () => body,
        writeJson: (_res: unknown, status: number, payload: unknown) => { writes.push({ status, payload }); },
      },
      security: { isTerminalAuthorized: () => true },
      paths: { resolveTheaterPath: () => theaterPath },
      operations: { list: () => operations },
    },
  } as unknown as FleetPluginServerContext;
}

const req = { method: "POST" } as never;
const res = {} as never;

async function seedRemotePair(tmpDir: string): Promise<{ readonly clonePath: string; readonly remotePath: string; readonly seedPath: string }> {
  const remotePath = path.join(tmpDir, "origin.git");
  const seedPath = path.join(tmpDir, "seed");
  const clonePath = path.join(tmpDir, "clone");
  await fs.mkdir(seedPath);
  await runGit(["init", "--bare", remotePath], { cwd: tmpDir });
  await runGit(["init"], { cwd: seedPath });
  await runGit(["config", "user.email", "test@test.com"], { cwd: seedPath });
  await runGit(["config", "user.name", "Test"], { cwd: seedPath });
  await fs.mkdir(path.join(seedPath, "docs"));
  await fs.writeFile(path.join(seedPath, "entry.txt"), "base\n");
  await fs.writeFile(path.join(seedPath, "docs", "guide.md"), "# guide\n");
  await runGit(["add", "."], { cwd: seedPath });
  await runGit(["commit", "-m", "base"], { cwd: seedPath });
  const defaultBranch = (await runGit(["branch", "--show-current"], { cwd: seedPath })).stdout.trim();
  await runGit(["remote", "add", "origin", remotePath], { cwd: seedPath });
  await runGit(["push", "origin", defaultBranch], { cwd: seedPath });
  await runGit(["clone", remotePath, clonePath], { cwd: tmpDir });
  await runGit(["config", "user.email", "test@test.com"], { cwd: clonePath });
  await runGit(["config", "user.name", "Test"], { cwd: clonePath });
  return { clonePath, remotePath, seedPath };
}

describe("Repository tree route", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-workbench-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists one folder layer at a commit, folders first", async () => {
    const { clonePath } = await seedRemotePair(tmpDir);
    const head = (await runGit(["rev-parse", "HEAD"], { cwd: clonePath })).stdout.trim();

    let writes: JsonWrite[] = [];
    await handleRepositoryTree(req, res, makeContext(clonePath, { theaterId: "t", ref: head }, writes));
    expect(writes[0]!.status).toBe(200);
    const root = writes[0]!.payload as TreeResult;
    expect(root.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["tree:docs", "blob:entry.txt"]);

    writes = [];
    await handleRepositoryTree(req, res, makeContext(clonePath, { theaterId: "t", ref: head, dirPath: "docs" }, writes));
    const docs = writes[0]!.payload as TreeResult;
    expect(docs.entries.map((entry) => entry.path)).toEqual(["docs/guide.md"]);
  });

  it("rejects symbolic refs and escaping folder paths at the lexical gate", async () => {
    const { clonePath } = await seedRemotePair(tmpDir);
    const writes: JsonWrite[] = [];
    await handleRepositoryTree(req, res, makeContext(clonePath, { theaterId: "t", ref: "HEAD" }, writes));
    expect(writes[0]!.status).toBe(400);
    expect(isSafeTreeDirPath("../outside")).toBe(false);
    expect(isSafeTreeDirPath("--options")).toBe(false);
    expect(isSafeTreeDirPath(":(top)")).toBe(false);
    expect(isSafeTreeDirPath("docs/nested")).toBe(true);
    expect(isSafeTreeDirPath("")).toBe(true);
  });

  it("parses ls-tree -z records into sorted entries", () => {
    const stdout = ["100644 blob abc\tb.txt", "040000 tree def\ta-dir", "100644 blob ghi\ta.txt", ""].join("\0");
    expect(parseTreeEntries(stdout).map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["tree:a-dir", "blob:a.txt", "blob:b.txt"]);
  });
});

describe("Repository workstate route", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-workstate-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reports lock state, upstream counts, and stationed operations", async () => {
    const { clonePath } = await seedRemotePair(tmpDir);
    await fs.writeFile(path.join(clonePath, "ahead.txt"), "ahead\n");
    await runGit(["add", "ahead.txt"], { cwd: clonePath });
    await runGit(["commit", "-m", "ahead commit"], { cwd: clonePath });

    const operations: StubOperation[] = [
      { id: "op-in", title: "stationed op", payload: { cwd: clonePath } },
      { id: "op-out", title: "elsewhere", payload: { cwd: tmpDir } },
      { id: "op-null", title: "no cwd", payload: null },
    ];
    let writes: JsonWrite[] = [];
    await handleRepositoryWorkstate(req, res, makeContext(clonePath, { theaterId: "t" }, writes, operations));
    expect(writes[0]!.status).toBe(200);
    const state = writes[0]!.payload as WorkstateResult;
    expect(state.indexLock).toBe(false);
    expect(state.inProgress).toBeNull();
    expect(state.ahead).toBe(1);
    expect(state.behind).toBe(0);
    expect(state.headSha).toMatch(/^[0-9a-f]{40}$/);
    // theater 루트 컨텍스트: 클론 안의 op만 주둔으로 집계된다 — tmpDir op는 클론 밖이다.
    expect(state.stationedOperations).toEqual([{ id: "op-in", title: "stationed op" }]);

    const gitDir = path.resolve(clonePath, (await runGit(["rev-parse", "--absolute-git-dir"], { cwd: clonePath })).stdout.trim());
    await fs.writeFile(path.join(gitDir, "index.lock"), "");
    writes = [];
    await handleRepositoryWorkstate(req, res, makeContext(clonePath, { theaterId: "t" }, writes, []));
    expect((writes[0]!.payload as WorkstateResult).indexLock).toBe(true);
  });

  it("parses ahead/behind from rev-list left-right counts", () => {
    expect(parseAheadBehind("3\t1\n".replace("\t", " "))).toEqual({ behind: 3, ahead: 1 });
    expect(parseAheadBehind("2\t5")).toEqual({ behind: 2, ahead: 5 });
    expect(parseAheadBehind("garbage")).toBeNull();
  });
});

describe("Repository remote routes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-remote-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("pushes the current branch to its upstream", async () => {
    const { clonePath, remotePath } = await seedRemotePair(tmpDir);
    await fs.writeFile(path.join(clonePath, "pushed.txt"), "pushed\n");
    await runGit(["add", "pushed.txt"], { cwd: clonePath });
    await runGit(["commit", "-m", "push me"], { cwd: clonePath });
    const localHead = (await runGit(["rev-parse", "HEAD"], { cwd: clonePath })).stdout.trim();

    const writes: JsonWrite[] = [];
    await handleRepositoryPush(req, res, makeContext(clonePath, { theaterId: "t" }, writes));
    expect(writes[0]!.status).toBe(200);
    const branch = (writes[0]!.payload as { readonly branch: string }).branch;
    expect((await runGit(["rev-parse", branch], { cwd: remotePath })).stdout.trim()).toBe(localHead);
  });

  it("fast-forwards on pull and refuses divergence with a typed error", async () => {
    const { clonePath, seedPath } = await seedRemotePair(tmpDir);
    const defaultBranch = (await runGit(["branch", "--show-current"], { cwd: seedPath })).stdout.trim();
    await fs.writeFile(path.join(seedPath, "upstream.txt"), "upstream\n");
    await runGit(["add", "upstream.txt"], { cwd: seedPath });
    await runGit(["commit", "-m", "upstream advance"], { cwd: seedPath });
    await runGit(["push", "origin", defaultBranch], { cwd: seedPath });

    let writes: JsonWrite[] = [];
    await handleRepositoryPull(req, res, makeContext(clonePath, { theaterId: "t" }, writes));
    expect(writes[0]!.status).toBe(200);
    expect(await fs.readFile(path.join(clonePath, "upstream.txt"), "utf8")).toBe("upstream\n");

    // 원격과 로컬을 서로 다르게 전진시켜 fast-forward 불가 상태를 만든다.
    await fs.writeFile(path.join(seedPath, "upstream2.txt"), "more\n");
    await runGit(["add", "upstream2.txt"], { cwd: seedPath });
    await runGit(["commit", "-m", "upstream advance 2"], { cwd: seedPath });
    await runGit(["push", "origin", defaultBranch], { cwd: seedPath });
    await fs.writeFile(path.join(clonePath, "local.txt"), "local\n");
    await runGit(["add", "local.txt"], { cwd: clonePath });
    await runGit(["commit", "-m", "local advance"], { cwd: clonePath });

    writes = [];
    await handleRepositoryPull(req, res, makeContext(clonePath, { theaterId: "t" }, writes));
    expect(writes[0]!.status).toBe(409);
    expect((writes[0]!.payload as { readonly error: string }).error).toBe("non_fast_forward");
  });

  it("classifies push and pull failure prose into typed codes", () => {
    expect(classifyPushError("! [rejected] main -> main (non-fast-forward)")).toBe("non_fast_forward");
    expect(classifyPushError("hint: Updates were rejected because the remote contains work")).toBe("non_fast_forward");
    expect(classifyPushError("fatal: other")).toBeNull();
    expect(classifyPullError("fatal: Not possible to fast-forward, aborting.")).toBe("non_fast_forward");
    expect(classifyPullError("error: Your local changes to the following files would be overwritten by merge:")).toBe("dirty_worktree");
    expect(classifyPullError("fatal: other")).toBeNull();
  });
});
