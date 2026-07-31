import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runGitMock = vi.hoisted(() => vi.fn());

vi.mock("../server/git-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/git-executor.js")>();
  return { ...actual, runGit: runGitMock };
});

const { handleRepositoryFetch } = await import("../server/fetch.js");

interface JsonWrite {
  readonly status: number;
  readonly payload: unknown;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const FETCH_ARGS = [
  "-c",
  "core.sshCommand=ssh",
  "-c",
  // git이 프록시 우회로 예약한 값은 none뿐 — false 같은 값은 프록시 명령으로 실행된다.
  "core.gitProxy=none",
  "-c",
  "protocol.allow=user",
  "fetch",
  "--prune",
  "--no-tags",
] as const;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function gitResult(stdout = "", stderr = "") {
  return { stdout, stderr, truncated: false, stderrTruncated: false };
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

describe("Repository fetch single-flight", () => {
  let tmpDir: string;
  let gitDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-fetch-flight-"));
    gitDir = path.join(tmpDir, ".git");
    await fs.mkdir(gitDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function startConcurrentFetches(secondMode: "auto" | "manual"): Promise<{
    readonly fetchCalls: number;
    readonly firstWrites: readonly JsonWrite[];
    readonly secondWrites: readonly JsonWrite[];
  }> {
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    let fetchCalls = 0;
    runGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === "rev-parse") return gitResult(`${gitDir}\n`);
      expect(args).toEqual(FETCH_ARGS);
      fetchCalls += 1;
      fetchStarted.resolve();
      await releaseFetch.promise;
      await fs.writeFile(path.join(gitDir, "FETCH_HEAD"), "fetched\n");
      return gitResult("", "");
    });

    const firstWrites: JsonWrite[] = [];
    const secondWrites: JsonWrite[] = [];
    const first = handleRepositoryFetch(
      { method: "POST" } as never,
      {} as never,
      makeContext(tmpDir, { theaterId: "theater", mode: "auto" }, firstWrites),
    );
    await fetchStarted.promise;
    const second = handleRepositoryFetch(
      { method: "POST" } as never,
      {} as never,
      makeContext(tmpDir, { theaterId: "theater", ...(secondMode === "auto" ? { mode: "auto" } : {}) }, secondWrites),
    );
    await vi.waitFor(() => {
      // --absolute-git-dir + --git-common-dir 두 번의 rev-parse가 요청마다 실행된다.
      expect(runGitMock.mock.calls.filter(([args]) => (args as readonly string[])[0] === "rev-parse")).toHaveLength(4);
    });
    releaseFetch.resolve();
    await Promise.all([first, second]);
    return { fetchCalls, firstWrites, secondWrites };
  }

  it("runs one fetch for concurrent automatic requests and rechecks the throttle", async () => {
    const result = await startConcurrentFetches("auto");

    expect(result.fetchCalls).toBe(1);
    expect(result.firstWrites).toEqual([{
      status: 200,
      payload: expect.objectContaining({ ok: true, fetchedAt: expect.any(String) }),
    }]);
    expect(result.secondWrites).toEqual([{
      status: 200,
      payload: { ok: true, skipped: "throttled", lastFetchAt: expect.any(String) },
    }]);
  });

  it("joins a manual request to an in-flight automatic fetch", async () => {
    const result = await startConcurrentFetches("manual");

    expect(result.fetchCalls).toBe(1);
    expect(result.secondWrites).toEqual(result.firstWrites);
  });

  it("throttles a linked worktree against the shared common dir FETCH_HEAD", async () => {
    // 메인 .git(common)의 FETCH_HEAD가 신선하면, 자기 gitdir에는 FETCH_HEAD가 없는
    // linked worktree의 auto 요청도 fetch 없이 throttled로 끝나야 한다(refs·원격 공유).
    const worktreeGitDir = path.join(gitDir, "worktrees", "linked");
    await fs.mkdir(worktreeGitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, "FETCH_HEAD"), "fetched\n");

    runGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] !== "rev-parse") throw new Error("fetch must not run");
      return (args as readonly string[]).includes("--git-common-dir")
        ? gitResult(`${gitDir}\n`)
        : gitResult(`${worktreeGitDir}\n`);
    });

    const writes: JsonWrite[] = [];
    await handleRepositoryFetch(
      { method: "POST" } as never,
      {} as never,
      makeContext(tmpDir, { theaterId: "theater", mode: "auto" }, writes),
    );

    expect(writes).toEqual([{
      status: 200,
      payload: { ok: true, skipped: "throttled", lastFetchAt: expect.any(String) },
    }]);
  });
});
