import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { InvalidRepoError, resolveGitCwd } from "./diff.js";
import { GitExecutorError, runGit } from "./git-executor.js";
import type { RepositorySearchItem } from "./types.js";

const SEARCH_COMMIT_CAP = 200;

export function parseRepositorySearchOutput(stdout: string, query: string, limit: number): RepositorySearchItem[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const results: RepositorySearchItem[] = [];
  for (const line of stdout.split("\n")) {
    const [fullHash = "", shortHash = "", ...subjectParts] = line.split("\0");
    const subject = subjectParts.join("\0");
    if (!/^[0-9a-f]{40}$/i.test(fullHash) || !/^[0-9a-f]{7,40}$/i.test(shortHash)) continue;
    const text = `${subject}\n${shortHash}\n${fullHash}`.toLocaleLowerCase();
    if (!tokens.every((token) => text.includes(token))) continue;
    results.push({ fullHash, shortHash, subject });
    if (results.length >= limit) break;
  }
  return results;
}

export async function handleRepositorySearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly repoRel?: unknown;
    readonly query?: unknown;
    readonly limit?: unknown;
  }>(req);
  if (
    !isPlainObject(body)
    || typeof body.theaterId !== "string"
    || typeof body.query !== "string"
    || body.query.trim() === ""
    || !Number.isInteger(body.limit)
    || (body.limit as number) < 1
    || (body.limit as number) > 8
    || "subPath" in body
    || "ref" in body
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  let gitCwd: string;
  try {
    gitCwd = (await resolveGitCwd(theaterPath, body.repoRel)).gitCwd;
  } catch (error) {
    if (error instanceof InvalidRepoError) {
      ctx.host.http.writeJson(res, 400, { error: error.code });
      return;
    }
    throw error;
  }

  try {
    // 검색어는 Git 인자로 전달하지 않는다. revision 입력 표면을 만들지 않고 열거된 ref 로그만 필터한다.
    const result = await runGit([
      "log",
      "--branches",
      "--tags",
      "--remotes",
      "--date-order",
      "-n",
      String(SEARCH_COMMIT_CAP),
      "--pretty=format:%H%x00%h%x00%s",
    ], { cwd: gitCwd });
    ctx.host.http.writeJson(res, 200, {
      repoRel: typeof body.repoRel === "string" ? body.repoRel : "",
      commits: parseRepositorySearchOutput(result.stdout, body.query, body.limit as number),
    });
  } catch (error) {
    if (error instanceof GitExecutorError) {
      if (error.code === "no_git_repo") {
        ctx.host.http.writeJson(res, 200, { repoRel: typeof body.repoRel === "string" ? body.repoRel : "", commits: [] });
        return;
      }
      if (error.code === "non_zero_exit" && error.stderr.includes("does not have any commits")) {
        ctx.host.http.writeJson(res, 200, { repoRel: typeof body.repoRel === "string" ? body.repoRel : "", commits: [] });
        return;
      }
      if (error.code === "git_unavailable") {
        ctx.host.http.writeJson(res, 422, { error: error.code });
        return;
      }
      ctx.host.http.writeJson(res, 500, { error: "git_failed" });
      return;
    }
    throw error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
