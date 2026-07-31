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
  "core.gitProxy=false",
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
      expect(runGitMock.mock.calls.filter(([args]) => (args as readonly string[])[0] === "rev-parse")).toHaveLength(2);
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
});
