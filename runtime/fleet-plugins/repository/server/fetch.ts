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

async function resolveCanonicalGitDir(gitCwd: string): Promise<string> {
  const gitDir = (await runGit(["rev-parse", "--absolute-git-dir"], { cwd: gitCwd })).stdout.trim();
  return fs.realpath(path.resolve(gitCwd, gitDir));
}

async function readLastFetchAt(gitDir: string): Promise<Date | null> {
  try {
    return (await fs.stat(path.join(gitDir, "FETCH_HEAD"))).mtime;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function countFetchProgress(stderr: string, marker: string): number {
  return stderr.split(/\r?\n/).filter((line) => line.includes(marker)).length;
}

async function readThrottleResult(gitDir: string): Promise<FetchResult | null> {
  const lastFetchAt = await readLastFetchAt(gitDir);
  if (!lastFetchAt || Date.now() - lastFetchAt.getTime() >= AUTO_FETCH_THROTTLE_MS) return null;
  return { ok: true, skipped: "throttled", lastFetchAt: lastFetchAt.toISOString() };
}

async function fetchRepository(gitCwd: string): Promise<FetchResult> {
  const result = await runGit([
    "-c",
    "core.sshCommand=ssh",
    "-c",
    "core.gitProxy=false",
    "-c",
    "protocol.allow=user",
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

async function runAutoFetch(gitCwd: string, gitDir: string): Promise<FetchResult> {
  const throttled = await readThrottleResult(gitDir);
  return throttled ?? fetchRepository(gitCwd);
}

async function fetchAutoSingleFlight(gitCwd: string, gitDir: string): Promise<FetchResult> {
  const existing = autoFetchInFlight.get(gitDir);
  if (existing) {
    await existing;
    const throttled = await readThrottleResult(gitDir);
    if (throttled) return throttled;
  }

  const operation = runAutoFetch(gitCwd, gitDir);
  autoFetchInFlight.set(gitDir, operation);
  try {
    return await operation;
  } finally {
    if (autoFetchInFlight.get(gitDir) === operation) autoFetchInFlight.delete(gitDir);
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
    const gitDir = await resolveCanonicalGitDir(gitCwd);
    const result = body.mode === "auto"
      ? await fetchAutoSingleFlight(gitCwd, gitDir)
      : await (autoFetchInFlight.get(gitDir) ?? fetchRepository(gitCwd));
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
