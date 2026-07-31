import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { InvalidRepoError, resolveGitCwd } from "./diff.js";
import { GitExecutorError, runGit } from "./git-executor.js";

const AUTO_FETCH_THROTTLE_MS = 300_000;

type FetchErrorToken = "auth_failed" | "network" | "no_remote";
type FetchResult =
  | { readonly ok: true; readonly skipped: "throttled"; readonly lastFetchAt: string }
  | { readonly ok: true; readonly fetchedAt: string; readonly lastFetchAt: string; readonly pruned: number; readonly newRefs: number };

const autoFetchInFlight = new Map<string, Promise<FetchResult>>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyFetchError(stderr: string): FetchErrorToken | null {
  if (/permission denied|authentication failed|could not read username|terminal prompts disabled|repository not found/i.test(stderr)) {
    return "auth_failed";
  }
  if (/could not resolve host|failed to connect|connection (refused|reset)|operation timed out|network is unreachable/i.test(stderr)) {
    return "network";
  }
  if (/no remote repository specified|does not appear to be a git repository/i.test(stderr)) {
    return "no_remote";
  }
  return null;
}

async function resolveGitIdentity(gitCwd: string): Promise<{ readonly gitDir: string; readonly commonDir: string }> {
  const [gitDirResult, commonDirResult] = await Promise.all([
    runGit(["rev-parse", "--absolute-git-dir"], { cwd: gitCwd }),
    runGit(["rev-parse", "--git-common-dir"], { cwd: gitCwd }),
  ]);
  // linked worktree의 common dir은 메인 체크아웃의 .git을 가리킨다. refs와 원격은 어느
  // worktree에서 fetch해도 공유되므로 throttle·single-flight의 좌표는 common dir로 삼는다.
  const [gitDir, commonDir] = await Promise.all([
    fs.realpath(path.resolve(gitCwd, gitDirResult.stdout.trim())),
    fs.realpath(path.resolve(gitCwd, commonDirResult.stdout.trim())),
  ]);
  return { gitDir, commonDir };
}

async function readLastFetchAt(gitDirs: readonly string[]): Promise<Date | null> {
  // FETCH_HEAD는 worktree gitdir마다 따로 쓰이므로, refs를 공유하는 모든 후보 중
  // 가장 최신 mtime을 "이 저장소의 마지막 fetch"로 본다.
  let newest: Date | null = null;
  for (const gitDir of gitDirs) {
    try {
      const { mtime } = await fs.stat(path.join(gitDir, "FETCH_HEAD"));
      if (!newest || mtime.getTime() > newest.getTime()) newest = mtime;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return newest;
}

function countFetchProgress(stderr: string, marker: string): number {
  return stderr.split(/\r?\n/).filter((line) => line.includes(marker)).length;
}

async function readThrottleResult(gitDirs: readonly string[]): Promise<FetchResult | null> {
  const lastFetchAt = await readLastFetchAt(gitDirs);
  if (!lastFetchAt || Date.now() - lastFetchAt.getTime() >= AUTO_FETCH_THROTTLE_MS) return null;
  return { ok: true, skipped: "throttled", lastFetchAt: lastFetchAt.toISOString() };
}

async function fetchRepository(gitCwd: string): Promise<FetchResult> {
  const result = await runGit([
    "-c",
    "core.sshCommand=ssh",
    "-c",
    // git 예약어 none만 프록시 우회다 — 다른 값은 프록시 "명령"으로 실행된다.
    "core.gitProxy=none",
    "-c",
    // protocol.allow=user는 ext를 never에서 허용으로 뒤집는다(GIT_PROTOCOL_FROM_USER unset) —
    // 기본 정책을 유지한 채 실행형 transport만 명시 차단한다.
    "protocol.ext.allow=never",
    "fetch",
    "--prune",
    "--no-tags",
  ], { cwd: gitCwd });
  const fetchedAt = new Date().toISOString();
  return {
    ok: true,
    fetchedAt,
    lastFetchAt: fetchedAt,
    pruned: countFetchProgress(result.stderr, " - [deleted] "),
    newRefs: countFetchProgress(result.stderr, " * [new branch] "),
  };
}

type GitIdentity = { readonly gitDir: string; readonly commonDir: string };

async function fetchHeadCandidates(identity: GitIdentity): Promise<readonly string[]> {
  const candidates = new Set([identity.gitDir, identity.commonDir]);
  try {
    // 형제 linked worktree의 FETCH_HEAD(<common>/worktrees/*/FETCH_HEAD)도 같은 refs를
    // 공유하는 저장소의 fetch 증거이므로 throttle 후보에 함께 본다.
    const worktreesDir = path.join(identity.commonDir, "worktrees");
    for (const entry of await fs.readdir(worktreesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.add(path.join(worktreesDir, entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [...candidates];
}

async function runAutoFetch(gitCwd: string, identity: GitIdentity): Promise<FetchResult> {
  const throttled = await readThrottleResult(await fetchHeadCandidates(identity));
  return throttled ?? fetchRepository(gitCwd);
}

async function fetchAutoSingleFlight(gitCwd: string, identity: GitIdentity): Promise<FetchResult> {
  const key = identity.commonDir;
  const existing = autoFetchInFlight.get(key);
  if (existing) {
    await existing;
    const throttled = await readThrottleResult(await fetchHeadCandidates(identity));
    if (throttled) return throttled;
  }

  const operation = runAutoFetch(gitCwd, identity);
  autoFetchInFlight.set(key, operation);
  try {
    return await operation;
  } finally {
    if (autoFetchInFlight.get(key) === operation) autoFetchInFlight.delete(key);
  }
}

export async function handleRepositoryFetch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly repoRel?: unknown;
    readonly mode?: unknown;
    readonly subPath?: unknown;
  }>(req);
  if (
    !isPlainObject(body)
    || "subPath" in body
    || typeof body.theaterId !== "string"
    || (body.mode !== undefined && body.mode !== "auto")
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  let gitCwd: string;
  try {
    // A selected Theater subdirectory is the Repository panel's current repo context
    // and has the same trust level as its Terminal PTY. Containment prevents repoRel
    // path escape; fetching an intentionally selected parent repo remains allowed.
    ({ gitCwd } = await resolveGitCwd(theaterPath, body.repoRel));
  } catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return; }
    throw error;
  }

  try {
    const identity = await resolveGitIdentity(gitCwd);
    const result = body.mode === "auto"
      ? await fetchAutoSingleFlight(gitCwd, identity)
      : await (autoFetchInFlight.get(identity.commonDir) ?? fetchRepository(gitCwd));
    ctx.host.http.writeJson(res, 200, result);
  } catch (error) {
    if (error instanceof GitExecutorError) {
      if (error.code === "timeout") {
        ctx.host.http.writeJson(res, 422, { error: "timeout" });
        return;
      }
      const classified = classifyFetchError(error.stderr);
      if (classified) {
        ctx.host.http.writeJson(res, 422, { error: classified });
        return;
      }
      if (error.code === "no_git_repo" || error.code === "git_unavailable") {
        ctx.host.http.writeJson(res, 422, { error: error.code });
        return;
      }
      ctx.host.http.writeJson(res, 500, { error: "git_failed" });
      return;
    }
    throw error;
  }
}
