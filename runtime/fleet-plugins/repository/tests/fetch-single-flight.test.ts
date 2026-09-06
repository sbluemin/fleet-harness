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
  // protocol.allow=user는 ext를 허용으로 뒤집으므로 금지 — 실행형 transport만 차단한다.
  "protocol.ext.allow=never",
  "-c",
  // reference-transaction 등 ref 훅의 zero-click 실행 차단.
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  // 첫 빈 값으로 configured credential.helper 전체를 리셋(화이트리스트 외 `!명령`/경로 helper 박탈)
  // 후 안전한 helper만 재주입한다. core.askPass도 비워 askpass 프로그램 실행을 막는다.
  "-c",
  "credential.helper=",
  "-c",
  "core.askPass=",
  "fetch",
  "origin",
  // 명시 refspec으로 prune 파괴 범위를 refs/remotes/<remote>/ 아래로 고정한다.
  "+refs/heads/*:refs/remotes/origin/*",
  // 로컬 transport는 repo config의 remote.<name>.uploadpack을 그대로 실행한다 — 표준 명령 강제.
  "--upload-pack=git-upload-pack",
  "--no-recurse-submodules",
  "--prune",
  "--no-tags",
  // fetch.pruneTags=true와 --prune이 결합하면 로컬 전용 태그가 지워진다 — 명시 차단.
  "--no-prune-tags",
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

type GitResult = ReturnType<typeof gitResult>;

// fetchRepository의 원격 해결 서열(rev-parse --abbrev-ref → config --get → remote)을
// 기본 응답으로 깔고, 실제 fetch 호출만 fetchImpl로 넘긴다.
function installRemoteResolutionMock(gitDir: string, fetchImpl: (args: readonly string[]) => Promise<GitResult>): void {
  runGitMock.mockImplementation(async (args: readonly string[]) => {
    if (args[0] === "rev-parse") {
      return (args as readonly string[]).includes("--abbrev-ref") ? gitResult("main\n") : gitResult(`${gitDir}\n`);
    }
    if (args[0] === "config") return gitResult("");
    if (args[0] === "remote") return gitResult("origin\n");
    return fetchImpl(args);
  });
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
    installRemoteResolutionMock(gitDir, async (args) => {
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
      // 요청 서열: identity 2회(--absolute-git-dir/--git-common-dir) + fetch 시도 시 --abbrev-ref 1회.
      // 첫 요청 3회 + 두 번째 요청 identity 2회 = 5회에서 두 번째가 in-flight에 합류한다.
      expect(runGitMock.mock.calls.filter(([args]) => (args as readonly string[])[0] === "rev-parse")).toHaveLength(5);
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

  it("maps a repository without any remote to 422 no_remote", async () => {
    runGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === "rev-parse") {
        return (args as readonly string[]).includes("--abbrev-ref") ? gitResult("main\n") : gitResult(`${gitDir}\n`);
      }
      if (args[0] === "config") return gitResult("");
      if (args[0] === "remote") return gitResult("");
      throw new Error("fetch must not run");
    });

    const writes: JsonWrite[] = [];
    await handleRepositoryFetch(
      { method: "POST" } as never,
      {} as never,
      makeContext(tmpDir, { theaterId: "theater", mode: "auto" }, writes),
    );

    expect(writes).toEqual([{ status: 422, payload: { error: "no_remote" } }]);
  });

  it("strips shell and path credential helpers but keeps allowlisted bare names", async () => {
    let captured: readonly string[] = [];
    runGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === "rev-parse") {
        return (args as readonly string[]).includes("--abbrev-ref") ? gitResult("main\n") : gitResult(`${gitDir}\n`);
      }
      if (args[0] === "config") {
        return (args as readonly string[]).includes("credential.helper")
          ? gitResult("!touch /tmp/pwned\nosxkeychain\n/tmp/git-credential-manager\ncache --timeout=300\n")
          : gitResult("");
      }
      if (args[0] === "remote") return gitResult("origin\n");
      captured = args;
      return gitResult("", "");
    });

    const writes: JsonWrite[] = [];
    await handleRepositoryFetch(
      { method: "POST" } as never,
      {} as never,
      makeContext(tmpDir, { theaterId: "theater", mode: "auto" }, writes),
    );

    expect(writes[0]?.status).toBe(200);
    expect(captured).toContain("credential.helper=");
    expect(captured).toContain("credential.helper=osxkeychain");
    expect(captured).toContain("core.askPass=");
    // `!cmd`·경로 형태(/tmp/git-credential-manager)·인자 형태(cache --timeout=300)는 전부 박탈.
    expect(captured.some((value) => String(value).includes("!touch"))).toBe(false);
    expect(captured.some((value) => String(value).includes("/tmp/"))).toBe(false);
    expect(captured.some((value) => String(value).includes("--timeout"))).toBe(false);
  });
});
