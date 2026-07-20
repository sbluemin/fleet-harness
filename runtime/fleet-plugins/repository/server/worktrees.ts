import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { InvalidRepoError, resolveGitCwd } from "./diff.js";
import { GitExecutorError, runGit } from "./git-executor.js";
import { resolveContainedGitDir } from "./git-marker.js";
import { parseWorktreePorcelainEntries } from "./log.js";
import { isPathContained, isSelectableRepoRel } from "./path-containment.js";
import type { WorktreeCandidate, WorktreesResult } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function handleRepositoryWorktrees(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly repoRel?: unknown; readonly subPath?: unknown }>(req);
  if (!isPlainObject(body) || "subPath" in body || typeof body.theaterId !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  let gitCwd: string;
  try { ({ gitCwd } = await resolveGitCwd(theaterPath, body.repoRel)); }
  catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return; }
    throw error;
  }

  let realTheaterPath: string;
  let realGitCwd: string;
  try { [realTheaterPath, realGitCwd] = await Promise.all([fs.realpath(theaterPath), fs.realpath(gitCwd)]); }
  catch { ctx.host.http.writeJson(res, 400, { error: "invalid_repo" }); return; }

  try {
    const result = await runGit(["worktree", "list", "--porcelain"], { cwd: gitCwd });
    const worktrees: WorktreeCandidate[] = [];
    const seen = new Set<string>();
    for (const worktree of parseWorktreePorcelainEntries(result.stdout)) {
      let realWorktree: string;
      try { realWorktree = await fs.realpath(worktree.worktreePath); }
      catch { continue; }
      if (!isPathContained(realTheaterPath, realWorktree)) continue;

      const relPath = path.relative(realTheaterPath, realWorktree);
      if (!isSelectableRepoRel(relPath) || seen.has(relPath)) continue;
      if ((await resolveContainedGitDir(realWorktree, realTheaterPath)) === null) continue;

      worktrees.push({
        relPath,
        name: path.basename(realWorktree),
        branch: worktree.branch ?? worktree.sha.slice(0, 7),
        current: realWorktree === realGitCwd,
      });
      seen.add(relPath);
    }

    const payload: WorktreesResult = { worktrees };
    ctx.host.http.writeJson(res, 200, payload);
  } catch (error) {
    if (error instanceof GitExecutorError) {
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
