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
});
