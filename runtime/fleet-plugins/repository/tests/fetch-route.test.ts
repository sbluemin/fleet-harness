import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyFetchError, handleRepositoryFetch } from "../server/fetch.js";
import { runGit } from "../server/git-executor.js";

interface JsonWrite {
  readonly status: number;
  readonly payload: unknown;
}

interface FetchFixture {
  readonly clonePath: string;
  readonly seedPath: string;
}

async function createFetchFixture(tmpDir: string): Promise<FetchFixture> {
  const remotePath = path.join(tmpDir, "origin.git");
  const seedPath = path.join(tmpDir, "seed");
  const clonePath = path.join(tmpDir, "clone");
  await fs.mkdir(seedPath);
  await runGit(["init", "--bare", remotePath], { cwd: tmpDir });
  await runGit(["init"], { cwd: seedPath });
  await runGit(["config", "user.email", "test@test.com"], { cwd: seedPath });
  await runGit(["config", "user.name", "Test"], { cwd: seedPath });
  await fs.writeFile(path.join(seedPath, "entry.txt"), "base\n");
  await runGit(["add", "entry.txt"], { cwd: seedPath });
  await runGit(["commit", "-m", "base"], { cwd: seedPath });
  const defaultBranch = (await runGit(["branch", "--show-current"], { cwd: seedPath })).stdout.trim();
  await runGit(["branch", "obsolete"], { cwd: seedPath });
  await runGit(["remote", "add", "origin", remotePath], { cwd: seedPath });
  await runGit(["push", "origin", defaultBranch, "obsolete"], { cwd: seedPath });
  await runGit(["clone", remotePath, clonePath], { cwd: tmpDir });
  await runGit(["branch", "new-remote"], { cwd: seedPath });
  await runGit(["push", "origin", "new-remote"], { cwd: seedPath });
  await runGit(["tag", "post-clone"], { cwd: seedPath });
  await runGit(["push", "origin", "refs/tags/post-clone"], { cwd: seedPath });
  await runGit(["push", "origin", "--delete", "obsolete"], { cwd: seedPath });
  return { clonePath, seedPath };
}

function makeContext(
  theaterPath: string,
  body: Record<string, unknown>,
  writes: JsonWrite[],
  authorized = true,
): FleetPluginServerContext {
  return {
    host: {
      http: {
        readJsonBody: async () => body,
        writeJson: (_res: unknown, status: number, payload: unknown) => { writes.push({ status, payload }); },
      },
      security: { isTerminalAuthorized: () => authorized },
      paths: { resolveTheaterPath: () => theaterPath },
    },
  } as unknown as FleetPluginServerContext;
}

describe("Repository fetch route", () => {
  let tmpDir: string;
  let fixture: FetchFixture;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-fetch-"));
    fixture = await createFetchFixture(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("prunes deleted remote refs and throttles the next automatic fetch", async () => {
    expect((await runGit(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/obsolete"], { cwd: fixture.clonePath })).stdout.trim())
      .toBe("refs/remotes/origin/obsolete");

    const manualWrites: JsonWrite[] = [];
    await handleRepositoryFetch(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.clonePath, { theaterId: "theater" }, manualWrites),
    );

    expect(manualWrites).toHaveLength(1);
    expect(manualWrites[0]?.status).toBe(200);
    expect(manualWrites[0]?.payload).toEqual(expect.objectContaining({
      ok: true,
      fetchedAt: expect.any(String),
      lastFetchAt: expect.any(String),
      pruned: expect.any(Number),
      newRefs: expect.any(Number),
    }));
    expect((manualWrites[0]?.payload as { readonly pruned: number }).pruned).toBeGreaterThanOrEqual(1);
    expect((manualWrites[0]?.payload as { readonly newRefs: number }).newRefs).toBeGreaterThanOrEqual(1);
    expect((await runGit(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/obsolete"], { cwd: fixture.clonePath })).stdout.trim())
      .toBe("");
    expect((await runGit(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/new-remote"], { cwd: fixture.clonePath })).stdout.trim())
      .toBe("refs/remotes/origin/new-remote");
    expect((await runGit(["for-each-ref", "--format=%(refname)", "refs/tags/post-clone"], { cwd: fixture.clonePath })).stdout.trim())
      .toBe("");

    const autoWrites: JsonWrite[] = [];
    await handleRepositoryFetch(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.clonePath, { theaterId: "theater", mode: "auto" }, autoWrites),
    );

    expect(autoWrites).toEqual([{
      status: 200,
      payload: {
        ok: true,
        skipped: "throttled",
        lastFetchAt: expect.any(String),
      },
    }]);
  });

  it("rejects a request without terminal Origin authorization before reading the body", async () => {
    const writes: JsonWrite[] = [];
    const readJsonBody = vi.fn(async <T>(): Promise<T | null> => ({ theaterId: "theater" }) as T);
    const ctx = {
      host: {
        http: {
          readJsonBody,
          writeJson: (_res: unknown, status: number, payload: unknown) => { writes.push({ status, payload }); },
        },
        security: { isTerminalAuthorized: () => false },
        paths: { resolveTheaterPath: () => fixture.clonePath },
      },
    } as unknown as FleetPluginServerContext;

    await handleRepositoryFetch({ method: "POST" } as never, {} as never, ctx);

    expect(writes).toEqual([{ status: 401, payload: { error: "unauthorized" } }]);
    expect(readJsonBody).not.toHaveBeenCalled();
  });
});

describe("classifyFetchError", () => {
  it.each([
    ["Permission denied (publickey).", "auth_failed"],
    ["fatal: could not resolve host: example.invalid", "network"],
    ["fatal: no remote repository specified.", "no_remote"],
  ])("classifies %s", (stderr, token) => {
    expect(classifyFetchError(stderr)).toBe(token);
  });
});
